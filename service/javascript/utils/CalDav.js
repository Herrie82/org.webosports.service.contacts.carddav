/*jslint sloppy: true, node: true */
/*global Log, http, url, Future, xml */

var CalDav = (function () {
    var httpClientCache = {};

    function endsWith(str, suffix) {
        return str.indexOf(suffix, str.length - suffix.length) !== -1;
    }

    function getValue(obj, field) {
        var f, f2 = field.toLowerCase();
        for (f in obj) {
            if (obj.hasOwnProperty(f)) {
                if (endsWith(f.toLowerCase(), f2.toLowerCase())) {
                    return obj[f];
                }
            }
        }
    }

    function getResponses(body) {
        var multistatus = getValue(body, "multistatus");
        if (multistatus) {
            return getValue(multistatus, "response") || [];
        }
    }

    function processStatus(stat) {
        Log.log_calDavParsingDebug("Processing stat: ", stat);
        if (stat.length >= 0) {
            if (stat.length !== 1) {
                throw {msg: "multiple stati... can't process."};
            } else {
                return getValue(stat[0], "$t"); //maybe extract number here?
            }
        } else {
            Log.log_calDavParsingDebug("Got single stat.");
            return getValue(stat, "$t");
        }
    }

    function processProp(prop) {
        Log.log_calDavParsingDebug("Processing prop: ", prop);
        if (prop && prop.length >= 0) {
            if (prop.length !== 1) {
                throw {msg: "multiple props... can't process."};
            } else {
                return prop[0];
            }
        }
        Log.log_calDavParsingDebug("Resulting prop: ", prop);
        return prop;
    }

    function processPropstat(ps) {
        Log.log_calDavParsingDebug("Processing propstat: " + JSON.stringify(ps));
        var propstat = {
            status: processStatus(getValue(ps, "status")),
            prop: processProp(getValue(ps, "prop"))
        };
        Log.log_calDavParsingDebug("Resulting propstat: ", propstat);
        return propstat;
    }

    function processResponse(res) {
        Log.log_calDavParsingDebug("Processing response ", res);
        var response = {
            href: getValue(getValue(res, "href"), "$t"),
            propstats: getValue(res, "propstat")
        }, i;
        if (!response.propstats) {
            response.propstats = [];
        } else if (response.propstats.length >= 0) {
            for (i = 0; i < response.propstats.length; i += 1) {
                response.propstats[i] = processPropstat(response.propstats[i]);
            }
        } else {
            response.propstats = [processPropstat(response.propstats)];
        }

        Log.log_calDavParsingDebug("Resulting response: ", response);
        return response;
    }

    function parseResponseBody(body) {
        var ri, responses = getResponses(body) || [], procRes = [];
        Log.log_calDavParsingDebug("Parsing from: ", body);
        if (responses.length >= 0) {
            for (ri = 0; ri < responses.length; ri += 1) {
                Log.log_calDavParsingDebug("Got response array: ", responses);
                procRes.push(processResponse(responses[ri]));
            }
        } else { //got only one response
            Log.log_calDavParsingDebug("Got single response: ", responses);
            procRes.push(processResponse(responses));
        }
        return procRes;
    }

    function getKeyValueFromResponse(body, searchedKey, notResolveText) {
        var responses = parseResponseBody(body), i, j, prop, key, text;
        for (i = 0; i < responses.length; i += 1) {
            for (j = 0; j < responses[i].propstats.length; j += 1) {
                prop = responses[i].propstats[j].prop || {};
                for (key in prop) {
                    if (prop.hasOwnProperty(key)) {
                        Log.log_calDavParsingDebug("Comparing ", key, " to ", searchedKey);
                        if (key.toLowerCase().indexOf(searchedKey) >= 0) {
                            Log.log_calDavParsingDebug("Returning ", prop[key], " for ", key);
                            text = getValue(prop[key], "$t");
                            if (notResolveText || !text) {
                                return prop[key];
                            } else {
                                return text;
                            }
                        }
                    }
                }
            }
        }
    }

    function getETags(body) {
        var responses = parseResponseBody(body), i, j, prop, key, eTags = [], etag;
        for (i = 0; i < responses.length; i += 1) {
            for (j = 0; j < responses[i].propstats.length; j += 1) {
                prop = responses[i].propstats[j].prop;
                for (key in prop) {
                    if (prop.hasOwnProperty(key)) {
                        Log.log_calDavParsingDebug("Comparing " + key + " to getetag.");
                        if (key.toLowerCase().indexOf('getetag') >= 0) {
                            etag = getValue(prop[key], "$t");
                        }
                    }
                }
                if (etag) { //add found etags with uri
                    eTags.push({etag: etag, uri: responses[i].href});
                }
            }
        }
        Log.log_calDavDebug("Etag directory: ", eTags);
        return eTags;
    }

    /**
     * Parses a multistatus-body into a list of folders.
     * Filter can be "calendar", "contact" or similar to filter
     * only folders that support this type of component.
     * Prefix is an optional prefix for the folder URLs, i.e. the home-folder URL.
     */
    function getFolderList(body, filter, prefix) {
        /**
         * Used during folder parsing. Decides by ressource type which kind of folder rt is.
         * Returns "calendar", "contact", "task", "calendar_tasks", or "ignored".
         */
        function getResourceType(rt) {
            var key, unspecCal = false;
            for (key in rt) {
                if (rt.hasOwnProperty(key)) {
                    if (key.toLowerCase().indexOf('vevent-collection') >= 0) {
                        return "calendar";
                    }
                    if (key.toLowerCase().indexOf('vcard-collection') >= 0 || key.toLowerCase().indexOf('addressbook') >= 0) {
                        return "contact";
                    }
                    if (key.toLowerCase().indexOf('vtodo-collection') >= 0) {
                        return "task";
                    }
                    if (key.toLowerCase().indexOf('calendar') >= 0) {
                        //issue: calendar can be todo or calendar.
                        unspecCal = true;
                    }
                }
            }

            if (unspecCal) {
                //if only found "calendar" must decide by supported components:
                return "calendar_tasks";
            }
            return "ignore";
        }

        /**
         * Used during folder detection. Parses which components a folder supports,
         * usual results are ["VEVENT", "VTODO", "VCARD"] or a subset of this.
         * Returned as array of strings.
         */
        function parseSupportedComponents(xmlComp) {
            var key, comps = [], array, i;
            for (key in xmlComp) {
                if (xmlComp.hasOwnProperty(key)) {
                    if (key.toLowerCase().indexOf('comp') >= 0) { //found list of components
                        array = xmlComp[key];
                        if (array.name) {
                            comps.push(array.name);
                        } else {
                            for (i = 0; i < array.length; i += 1) {
                                comps.push(array[i].name);
                            }
                        }
                        break;
                    }
                }
            }
            return comps;
        }

        /**
         * Decides type of folder by component.
         */
        function decideByComponents(supComp) {
            var i, calHint = 0, taskHint = 0;
            if (supComp) {
                for (i = 0; i < supComp.length; i += 1) {
                    if (supComp[i] === "VEVENT") {
                        calHint += 1;
                    } else if (supComp[i] === "VTODO") {
                        taskHint += 1;
                    }
                }
            }

            if (taskHint > calHint) {
                return "task";
            }
            return "calendar"; //if don't have information, try calendar.. ;)
        }

        var responses = parseResponseBody(body), i, j, prop, key, folders = [], folder, tmpVal;
        for (i = 0; i < responses.length; i += 1) {
            folder = {
                uri: responses[i].href,
                remoteId: responses[i].href,
                supportedComponents: []
            };
            for (j = 0; j < responses[i].propstats.length; j += 1) {
                prop = responses[i].propstats[j].prop;
                for (key in prop) {
                    if (prop.hasOwnProperty(key)) {
                        Log.log_calDavParsingDebug("Processing key " + key);
                        if (key.toLowerCase().indexOf('displayname') >= 0) {
                            folder.name = folder.name || getValue(prop[key], "$t");
                            Log.log_calDavParsingDebug("is displayname, result: ", folder.name);
                        } else if (key.toLowerCase().indexOf('resourcetype') >= 0) {
                            tmpVal = getResourceType(prop[key]);
                            if (!folder.resource || tmpVal !== "ignore") {
                                folder.resource = tmpVal;
                            }
                            Log.log_calDavParsingDebug("is resourcetype, result: ", folder.resource);
                        } else if (key.toLowerCase().indexOf('supported-calendar-component-set') >= 0) {
                            tmpVal = parseSupportedComponents(prop[key]);
                            if (tmpVal) {
                                folder.supportedComponents = folder.supportedComponents.concat(tmpVal);
                            }
                            Log.log_calDavParsingDebug("is supported-calendar-component-set, result: ", folder.supportedComponents);
                        } else if (key.toLowerCase().indexOf('getctag') >= 0) {
                            folder.ctag = getValue(prop[key], "$t");
                        }
                    }
                }
                if (folder.resource === "calendar_tasks") {
                    folder.resource = decideByComponents(folder.supportedComponents);
                    Log.log_calDavParsingDebug("Decided ", folder.resource, " for ", folder.name);
                }
            }

            if (!filter || folder.resource === filter) {
                if (folder.uri.toLowerCase().indexOf("http") !== 0) {
                    folder.uri = (prefix || "") + folder.uri;
                }
                folder.remoteId = folder.uri;
                folders.push(folder);
            }
            Log.log_calDavParsingDebug("New folders: ", folders);
            Log.log_calDavParsingDebug("================================================================================");
        }
        Log.log_calDavDebug("Got folders: ");
        for (i = 0; i < folders.length; i += 1) {
            Log.log_calDavDebug(folders[i]);
        }
        return folders;
    }

    function getHttpClient(options) {
        var key = options.prefix;
        if (!httpClientCache[key]) {
            httpClientCache[key] = {};
        }

        if (httpClientCache[key].connected) {
            Log.log_calDavDebug("Already connected");
            httpClientCache[key].client.removeAllListeners("error"); //remove previous listeners.
        } else {
            Log.log_calDavDebug("Creating connection from ", options.port, options.headers.host, options.protocol === "https:");
            httpClientCache[key].client = http.createClient(options.port, options.headers.host, options.protocol === "https:");
            httpClientCache[key].connected = true; //connected is not 100% true anymore. But can't really check for connection without adding unnecessary requests.
        }
        return httpClientCache[key].client;
    }

    function parseURLIntoOptions(inUrl, options) {
        if (!inUrl) {
            return;
        }

        var parsedUrl = url.parse(inUrl);
        if (!parsedUrl.hostname) {
            parsedUrl = url.parse(inUrl.replace(":/", "://")); //somehow SOGo returns uri with only one / => this breaks URL parsing.
        }
        options.path = parsedUrl.pathname || "/";
        if (!options.headers) {
            options.headers = {};
        }
        options.headers.host = parsedUrl.hostname;
        options.port = parsedUrl.port;
        options.protocol = parsedUrl.protocol;

        if (!parsedUrl.port) {
            options.port = parsedUrl.protocol === "https:" ? 443 : 80;
        }

        options.prefix = options.protocol + "//" + options.headers.host + ":" + options.port;
    }

    function sendRequest(options, data, retry) {
        var body = "",
            future = new Future(),
            httpClient,
            req,
            received = false,
            lastSend = 0,
            timeoutID,
            dataBuffer = new Buffer(data, 'utf8');

        if (retry === undefined) {
            retry = 0;
        }

        function checkTimeout() {
            var now;
            if (!received) {
                now = Date.now();
                Log.debug("Message was send last before " + ((now - lastSend) / 1000) + " seconds, was not yet received.");
                if (now - lastSend > 30 * 1000) { //last send before 30 seconds.. is that too fast?
                    clearTimeout(timeoutID);
                    if (retry <= 5) {
                        Log.log_calDavDebug("Trying to resend message.");
                        sendRequest(options, data, retry + 1).then(function (f) {
                            future.result = f.result; //transfer future result.
                        });
                    } else {
                        Log.log("Already tried 5 times. Seems as if server won't answer? Sync seems broken.");
                        future.result = { returnValue: false, msg: "Message timedout, even after retries. Sync failed." };
                    }
                } else {
                    timeoutID = setTimeout(checkTimeout, 1000);
                }
            } else {
                clearTimeout(timeoutID);
                Log.log_calDavDebug("Message received, returning.");
            }
        }

        function endCB(res) {
            var result, newPath, redirectOptions;
            if (received) {
                Log.log_calDavDebug(options.path, " was already received... exiting without callbacks.");
            }
            received = true;
            Log.debug("Answer received."); //thoes this also happen on timeout??
            clearTimeout(timeoutID);
            Log.log_calDavDebug("Body: " + body);

            result = {
                returnValue: (res.statusCode < 400),
                etag: res.headers.etag,
                returnCode: res.statusCode,
                body: body,
                uri: options.prefix + options.path
            };

            if (res.statusCode === 302 || res.statusCode === 301 || res.statusCode === 307 || res.statusCode === 308) {
                Log.log_calDavDebug("Location: ", res.headers.location);
                if (res.headers.location.indexOf("http") < 0) {
                    res.headers.location = options.prefix + res.headers.location;
                }

                //check if redirected to identical location
                if (res.headers.location === options.prefix + options.path || //if strings really are identical
                    //or we have default port and string without port is identical:
                        (
                            (
                                (options.port === 80 && options.protocol === "http:") ||
                                (options.port === 443 && options.protocol === "https:")
                            ) &&
                                res.headers.location === options.protocol + "//" + options.headers.host + options.path
                        )) {
                    //don't run into redirection endless loop:
                    Log.log("Preventing enless redirect loop, because of redirection to identical location: " + res.headers.location + " === " + options.prefix + options.path);
                    result.returnValue = false;
                    future.result = result;
                    if (timeoutID) {
                        clearTimeout(timeoutID);
                    }
                    return future;
                }
                parseURLIntoOptions(res.headers.location, options);
                Log.log_calDavDebug("Redirected to ", res.headers.location);
                sendRequest(options, data).then(function (f) {
                    future.result = f.result; //transfer future result.
                });
            } else if (res.statusCode < 300 && options.parse) { //only parse if status code was ok.
                result.parsedBody = xml.xmlstr2json(body);
                Log.log_calDavParsingDebug("Parsed Body: ", result.parsedBody);
                future.result = result;
            } else {
                future.result = result;
            }
        }

        function responseCB(res) {
            Log.log_calDavDebug('STATUS: ', res.statusCode);
            Log.log_calDavDebug('HEADERS: ', res.headers);
            res.setEncoding('utf8');
            res.on('data', function dataCB(chunk) {
                lastSend = Date.now();
                body += chunk;
            });
            res.on('end', endCB.bind(this, res));
        }

        function doSendRequest() {
            options.headers["Content-Length"] = Buffer.byteLength(data, 'utf8'); //get length of string encoded as utf8 string.

            Log.log_calDavDebug("Sending request ", data, " to server.");
            Log.log_calDavDebug("Options: ", options);
            Log.debug("Sending request to " + options.prefix + options.path);
            lastSend = Date.now();
            req = httpClient.request(options.method, options.path, options.headers);
            req.on('response', responseCB);

            req.on('error', function (e) {
                Log.log('problem with request: ' + e.message);
                lastSend = 0; //let's trigger retry.
                //future.exception = { code: e.errno, msg: "httpRequest error " + e.message };
            });

            // write data to request body
            req.end(data, "utf8");
        }

        timeoutID = setTimeout(checkTimeout, 1000);
        lastSend = Date.now();
        httpClient = getHttpClient(options);

        httpClient.on("error", function (e) {
            Log.log("Error with http connection: ", e);
            httpClientCache[options.prefix].connected = false;
            lastSend = 0; //trigger retry.
        });

        doSendRequest();
        return future;
    }

    function preProcessOptions(params) {
        var options = {
            method: "PROPFIND",
            headers: {
                //Depth: 0, //used for DAV reports.
                Prefer: "return-minimal", //don't really know why that is.
                "Content-Type": "application/xml; charset=utf-8", //necessary
                Connection: "keep-alive",
                Authorization: params.authToken,
                "User-Agent": "org.webosports.cdav-connector"
            }
        };
        parseURLIntoOptions(params.path, options);
        return options;
    }

    function generateMoreTestPaths(folder, tryFolders) {
        var newFolders = [folder], i, j, duplicate, tmp,
            replacePart = function (data, searchString, replacement, caseInsensitive) {
                var tmpStr;
                if (data.indexOf(searchString) >= 0) {
                    return data.replace(searchString, replacement);
                } else if (data.toLowerCase().indexOf(searchString) >= 0) {
                    tmpStr = data.substr(data.toLowerCase().indexOf(searchString), searchString.length);
                    return data.replace(tmpStr, replacement); //could theoretically screw up path.
                }
                return false;
            },
            stringReplacements = [
                {search: "caldav", replace: "carddav"},
                {search: "caldav", replace: "contacts"},
                {search: "calendar", replace: "carddav"},
                {search: "calendar", replace: "contacts"},
                {search: "carddav", replace: "calendar"},
                {search: "contacts", replace: "caldav"},
                {search: "contacts", replace: "calendar"}
            ];

        for (i = 0; i < stringReplacements.length; i += 1) {
            tmp = replacePart(folder, stringReplacements[i].search, stringReplacements[i].replace);
            while (tmp !== false) {
                newFolders.push(tmp);
                tmp = replacePart(tmp, stringReplacements[i].search, stringReplacements[i].replace);
            }
        }

        //check for duplicates:
        for (j = 0; j < newFolders.length; j += 1) {
            duplicate = false;
            for (i = 0; i < tryFolders.length; i += 1) {
                if (newFolders[j] === tryFolders[i]) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) {
                tryFolders.push(newFolders[j]);
            }
        }
    }

    //define public interface
    return {
        //checks only authorization.
        //But does that with propfind user principal now, instead of GET.
        //Issue was that one can get the login screen without (and also with wrong) credentials.
        //check result.returnValue from feature.
        //this does not really look at the error message. All codes >= 400 return a false => i.e. auth error. But also returns status code.
        checkCredentials: function (params) {
            var options = preProcessOptions(params), future = new Future(), data;

            options.method = "PROPFIND";
            data = "<d:propfind xmlns:d='DAV:'><d:prop><d:current-user-principal /></d:prop></d:propfind>";

            future.nest(sendRequest(options, data));
            return future;
        },

        //determines if a sync is necessary for datastore given by url.
        //needs: { username, password, url, ctag }
        //returns future, which will eventually get result which contains ctag and
        checkForChanges: function (params) {
            var options = preProcessOptions(params), future = new Future(), data;
            options.method = "PROPFIND";
            options.headers.Depth = 0;
            options.parse = true;

            //seems to be identical for caldav and carddav. RFC of carddav does not talk about this.
            data = "<d:propfind xmlns:d=\"DAV:\" xmlns:cs=\"http://calendarserver.org/ns/\">";
            data += "<d:prop>";
            data += "<d:displayname />";
            data += "<cs:getctag />";
            data += "</d:prop>";
            data += "</d:propfind>";

            future.nest(sendRequest(options, data));

            future.then(function () {
                var result = future.result, ctag;
                if (result.returnValue) {
                    ctag = getKeyValueFromResponse(result.parsedBody, 'getctag');
                } else {
                    Log.log("Could not receive ctag.");
                }
                Log.log_calDavDebug("New ctag: " + ctag + ", old ctag: " + params.ctag);
                future.result = { success: result.returnValue, needsUpdate: ctag !== params.ctag, ctag: ctag };
            });

            return future;
        },

        downloadEtags: function (params, path) {
            var options = preProcessOptions(params), future = new Future(), data;
            if (path) {
                options.path = path;
            }
            options.method = "REPORT";
            options.headers.Depth = 1;
            options.parse = true;

            //maybe add sensible timerange here: <C:time-range start="20040902T000000Z" end="20040903T000000Z"/>
            //be sure to not delete local objects that are beyond that timerange! ;)

            data = "<c:calendar-query xmlns:d='DAV:' xmlns:c='urn:ietf:params:xml:ns:caldav'><d:prop><d:getetag /></d:prop><c:filter><c:comp-filter name='VCALENDAR'><c:comp-filter name='VEVENT'></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>";
            if (params.cardDav) {
                data = "<c:addressbook-query xmlns:d='DAV:' xmlns:c='urn:ietf:params:xml:ns:carddav'><d:prop><d:getetag /></d:prop><c:filter><c:comp-filter name='VCARD'></c:comp-filter></c:filter></c:addressbook-query>";
            }

            future.nest(sendRequest(options, data));

            future.then(function () {
                var result = future.result, etags;
                if (result.returnValue) {
                    etags = getETags(result.parsedBody);
                    future.result = { returnValue: true, etags: etags };
                } else {
                    future.result = { returnValue: false };
                    Log.log("Could not get eTags.");
                }
            });

            return future;
        },

        /*
         * Downloadds a single object, whose uri is in obj.uri.
         * Future will contain data member which contains the body, i.e. the complete data of the object.
         */
        downloadObject: function (params, obj) {
            var future = new Future(), options = preProcessOptions(params);
            options.method = "GET";
            options.path = obj.uri;
            options.headers["Content-Type"] = "text/calendar; charset=utf-8";
            if (params.cardDav) {
                options.headers["Content-Type"] = "text/vcard; charset=utf-8";
            }

            future.nest(sendRequest(options, ""));

            future.then(function () {
                var result = future.result;
                future.result = { returnValue: result.returnValue, data: result.body };
            });

            return future;
        },

        /*
         * Sends delete request to the server.
         * Future will cotain uri member with old uri for reference.
         */
        deleteObject: function (params, obj) {
            var future = new Future(), options = preProcessOptions(params);
            options.path = obj.uri;
            options.method = "DELETE";

            //prevent overriding remote changes.
            if (obj.etag) {
                options.headers["If-Match"] = obj.etag;
            }

            future.nest(sendRequest(options, ""));

            return future;
        },

        /*
         * Puts an object to server.
         * If server delivers etag in response, will also add etag to future.result.
         */
        putObject: function (params, obj) {
            var future = new Future(), options = preProcessOptions(params);
            options.method = "PUT";
            options.path = obj.uri;
            options.headers["Content-Type"] = "text/calendar; charset=utf-8";
            if (params.cardDav) {
                options.headers["Content-Type"] = "text/vcard; charset=utf-8";
            }

            //prevent overriding remote changes.
            if (obj.etag) {
                options.headers["If-Match"] = obj.etag;
            } else {
                options.headers["If-None-Match"] = "*";
            }

            future.nest(sendRequest(options, obj.data));

            return future;
        },

        //discovers folders for contacts and calendars.
        //future.result will contain array folders.
        //folders contain uri, resource = contact/calendar/task
        discovery: function (params) {
            var future = new Future(), options = preProcessOptions(params), data, homes = [], folders = { subFolders: {} }, folderCB,
                tryFolders = [], principals = [];

            function getHomeCB(addressbook, index) {
                var result = future.result, home;
                if (result.returnValue === true) {
                    //look for either calendar- or addressbook-home-set :)
                    home = getValue(getValue(getKeyValueFromResponse(result.parsedBody, "-home-set", true), "href"), "$t");
                    if (!home) {
                        Log.log("Could not get " + (addressbook ? "addressbook" : "calendar") + " home folder.");
                    } else {
                        Log.log_calDavDebug("Original home: " + home);
                        if (home.indexOf("http") === 0) {
                            Log.log_calDavDebug("Home already complete?");
                        } else {
                            Log.log("Augmenting home...");
                            home = options.prefix + home;
                        }
                        Log.log_calDavDebug("Got " + (addressbook ? "addressbook" : "calendar") + "-home: " + home);
                    }
                } else {
                    //error, stop, return failure.
                    Log.log("Error in getHomeCB: " + JSON.stringify(result));
                    //future.result = result;
                }

                if (!home) {
                    if (index < tryFolders.length) {
                        Log.log_calDavDebug("Trying to ask for " + (addressbook ? "addressbook" : "calendar") + "-home-set on next url: " + JSON.stringify(tryFolders[index]) + " index: " + index);
                        parseURLIntoOptions(tryFolders[index], options);
                        future.nest(sendRequest(options, data));
                        future.then(getHomeCB.bind(this, addressbook, index + 1));
                        return;
                    } else {
                        Log.log_calDavDebug("Tried all folders. Will try to get " + (addressbook ? "addressbook" : "calendar") + " folders from original url.");
                        home = params.originalUrl;
                    }
                }

                if (homes.length > 0 && homes[0] === home) {
                    Log.log_calDavDebug("Homes identical, ignore second one.");
                } else {
                    homes.push(home);
                }

                if (!addressbook) {
                    data = "<d:propfind xmlns:d='DAV:' xmlns:c='urn:ietf:params:xml:ns:carddav'><d:prop><c:addressbook-home-set/></d:prop></d:propfind>";
                    folders.calendarHome = home;
                    parseURLIntoOptions(tryFolders[0], options);
                    future.nest(sendRequest(options, data));
                    future.then(getHomeCB.bind(this, true, 1)); //calendar done, start with addressbook
                } else {
                    folders.addressbookHome = home;
                    //start folder search and consume first folder.
                    Log.log_calDavDebug("Getting folders from " + homes[0]);
                    params.cardDav = false;
                    params.path = homes.shift();
                    future.nest(this.getFolders(params));
                    future.then(this, folderCB);
                }
            }

            function principalCB(index) {
                var result = future.result, principal, folder, i;
                if (result.returnValue === true) {
                    principal = getKeyValueFromResponse(result.parsedBody, 'current-user-principal', true);
                    if (principal) {
                        principal = getValue(getValue(principal, "href"), "$t");
                        Log.log_calDavDebug("Got principal: " + principal);
                        if (principal) {
                            if (principal.indexOf("http") < 0) {
                                principal = options.prefix + principal;
                            }
                            Log.log_calDavDebug("Adding: " + principal);
                            generateMoreTestPaths(principal, principals);
                        }
                    }
                } else {
                    //error, stop, return failure.
                    Log.log("Error in getPrincipal: " + JSON.stringify(result));
                    //future.result = result;
                }

                if (index < tryFolders.length) {
                    parseURLIntoOptions(tryFolders[index], options);
                    future.nest(sendRequest(options, data));
                    future.then(principalCB.bind(this, index + 1));
                } else {
                    if (principals.length === 0) {
                        Log.log("Could not get any principal at all.");
                    }

                    //prepare home folder search:
                    options.headers.Depth = 0;
                    data = "<d:propfind xmlns:d='DAV:' xmlns:c='urn:ietf:params:xml:ns:caldav'><d:prop><c:calendar-home-set/></d:prop></d:propfind>";

                    //reorder array, so that principal folders are tried first:
                    tryFolders = principals.concat(tryFolders);

                    parseURLIntoOptions(tryFolders[0], options);
                    future.nest(sendRequest(options, data));
                    future.then(getHomeCB.bind(this, false, 1));
                }
            }

            //some folders to probe for:
            //push original URL to test-for-home-folders.
            generateMoreTestPaths(params.originalUrl, tryFolders);
            parseURLIntoOptions(params.originalUrl, options); //set prefix for the well-known tries.
            generateMoreTestPaths(options.prefix + "/.well-known/caldav", tryFolders);
            generateMoreTestPaths(options.prefix + "/.well-known/carddav", tryFolders);

            //first get user principal:
            options.method = "PROPFIND";
            options.parse = true;
            parseURLIntoOptions(tryFolders[0], options);
            data = "<d:propfind xmlns:d='DAV:'><d:prop><d:current-user-principal /></d:prop></d:propfind>";
            future.nest(sendRequest(options, data));
            future.then(principalCB.bind(this, 1));

            folderCB = function () {
                var result = future.result, i, f, fresult = [], key;
                if (result.returnValue === true) {
                    //prevent duplicates by URI.
                    for (i = 0; i < result.folders.length; i += 1) {
                        f = result.folders[i];
                        folders.subFolders[f.uri] = f;
                    }
                } else {
                    Log.log("Error during folder-search: " + JSON.stringify(result));
                    //future.result = result;
                }

                if (homes.length > 0) { //if we still have unsearched home-foders, search them:
                    Log.log_calDavDebug("Getting folders from " + homes[0]);
                    params.cardDav = true; //bad hack.
                    params.path = homes.shift();
                    future.nest(this.getFolders(params));
                    future.then(this, folderCB);
                } else {
                    for (key in folders.subFolders) {
                        if (folders.subFolders.hasOwnProperty(key)) {
                            fresult.push(folders.subFolders[key]);
                        }
                    }
                    future.result = {
                        returnValue: true,
                        folders: fresult,
                        calendarHome: folders.calendarHome,
                        contactHome: folders.addressbookHome
                    };
                }
            };

            return future;
        },

        //get's folders below uri. Can filter for addressbook, calendar or tasks.
        //future.result will contain array folders
        getFolders: function (params, filter) {
            var future = new Future(), options = preProcessOptions(params), data, folders;

            options.headers.Depth = 1;
            options.parse = true;

            data = "<d:propfind xmlns:d='DAV:' xmlns:c='urn:ietf:params:xml:ns:caldav'><d:prop><d:resourcetype /><d:displayname /><c:supported-calendar-component-set /></d:prop></d:propfind>";
            if (params.cardDav) {
                data = "<d:propfind xmlns:d='DAV:' xmlns:c='urn:ietf:params:xml:ns:carddav'><d:prop><d:resourcetype /><d:displayname /></d:prop></d:propfind>";
            }
            future.nest(sendRequest(options, data));

            future.then(this, function foldersCB() {
                var result = future.result;
                if (result.returnValue === true) {
                    folders = getFolderList(result.parsedBody, filter, options.prefix);
                    future.result = {
                        returnValue: true,
                        folders: folders
                    };
                } else {
                    Log.log("Error during getFolders: " + JSON.stringify(result));
                    future.result = result;
                }
            });

            return future;
        },

        testFolderParsing: function (body) {
            return getFolderList(body);
        }
    };
}());

module.exports = CalDav;
