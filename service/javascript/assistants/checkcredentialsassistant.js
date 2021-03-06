/*jslint nomen: true, node: true */
/*global DB, searchAccountConfig, Future, Log, UrlSchemes, Transport, checkResult, libPath */
/*exported checkCredentialsAssistant*/
var KeyStore = require(libPath + "KeyStore.js");
var Base64 = require(libPath + "Base64.js");
var AuthManager = require(libPath + "AuthManager.js");

/* Validate contact username/password */
var checkCredentialsAssistant = function () { "use strict"; };

checkCredentialsAssistant.prototype.run = function (outerfuture) {
	"use strict";
	var args = this.controller.args, base64Auth, future = new Future(), url = args.url, urlScheme = args.urlScheme, name = args.name, userAuth;
	//debug("Account args =", args);

	// Base64 encode username and password
	base64Auth = "Basic " + Base64.encode(args.username + ":" + args.password);
	userAuth = {
		username: args.username,
		password: args.password,
		authToken: base64Auth
	};
	if (args.oauth) {
		userAuth = args.oauth;
	}

	if (args && args.config) {
		if (!url) {
			url = args.config.url;
		}
		if (!name) {
			name = args.config.name;
		}
		if (!urlScheme) {
			urlScheme = args.config.urlScheme;
		}
	}

	if (args.accountId) {
		Log.debug("Have account id => this is change credentials call, get config object from db.");
		future.nest(searchAccountConfig(args));
	} else {
		future.result = {returnValue: true,  config: {url: url, urlScheme: urlScheme, name: name, username: args.username}};
	}

	//build result and send it back to UI.
	function buildResult() {
		outerfuture.result = {
			success: true,
			credentials: {
				common: {
					password: userAuth.password,
					username: userAuth.username,
					url: url
				}
			},
			config: {
				password: userAuth.password,
				username: userAuth.username,
				url: url,
				urlScheme: urlScheme,
				name: name
			}
		};
	}

	future.then(this, function gotConfigObject() {
		var result = checkResult(future), path, newPath, scheme;
		if (result.returnValue === true) {
			this.config = result.config;
			this.config.ignoreSSLCertificateErrors = args.ignoreSSLCertificateErrors;

			urlScheme = urlScheme || this.config.urlScheme;
			url = url || this.config.url;
			userAuth.username = userAuth.username || this.config.username;
			if (scheme && !scheme.oauth) {
				Log.debug("Overwiting authToken with username from db: ", userAuth.username);
				userAuth.authToken = "Basic " + Base64.encode(userAuth.username + ":" + args.password);
			}
		}
		scheme = UrlSchemes.urlSchemes[urlScheme];

		//use forced scheme to resolve here, otherwise search strings in URL.
		url = UrlSchemes.resolveURL(url, userAuth.username, "checkCredentials", urlScheme) || url;

		if (url) {
			path = url;
		} else {
			Log.log("No URL. Can't check credentials!");
			outerfuture.exception = new Transport.BadRequestError("No URL. Can't check credentials!");
			return;
		}

		//Do this here to prevent users from setting credentials with 2.2.4 app.
		if (scheme && scheme.oauth && !userAuth.oauth) {
			Log.log("Accounts needs oAuth, but none supplied.");
			outerfuture.exception = new Transport.BadRequestError("Accounts needs oAuth, but none supplied. Change credentials won't work for oauth accounts in webOS 2.x.");
			return;
		}

		// Test basic authentication. If this fails username and or password is wrong
		future.nest(
			AuthManager.checkAuth(
				userAuth,
				path,
				-1,
				{
					userAuth: userAuth,
					ignoreSSLCertificateErrors: this.config.ignoreSSLCertificateErrors
				}
			)
		);
	});

	future.then(this, function credentialsCheckCB() {
		var result = checkResult(future), msg, exception, returnCode;
		// Check if we are getting a good return code for success
		if (result.returnValue === true) {
			// Pass back credentials and config (username/password/url);
			// config is passed to onCreate where
			// we will save username/password in encrypted storage
			Log.debug("Password accepted");

			if (args.accountId) {
				Log.log("Had account id => this is change credentials call, update config object");

				future.nest(KeyStore.putKey(args.accountId, userAuth));
			} else {
			//send results back to UI:
				buildResult();
			}

		} else {
			Log.debug("Password rejected");
			returnCode = result.returnCode;
			if (!returnCode && result.exception) {
				returnCode = result.exception.returnCode;
			}
			switch (returnCode) {
			case 404:
				msg = "URL wrong, document not found. - URL: " + result.uri;
				exception = new Transport.BadRequestError(msg);
				break;
			case 403:
				msg = "Access forbidden, probably server or URL issue. - URL: " + result.uri;
				exception = new Transport.BadRequestError(msg);
				break;
			case 401:
				msg = "Credentials are wrong. - URL: " + result.uri;
				exception = new Transport.AuthenticationError(msg);
				break;
			case 405:
				msg = "Method not allowed, probably URL is no caldav/carddav URL. Please look up configuration of your server or report back to developers. - URL: " + result.uri;
				exception = new Transport.BadRequestError(msg);
				break;
			default:
				msg = "Connection issue: " + result.returnCode + ". Maybe try again later or check url. - URL: " + result.uri;
				exception = new Transport.TimeoutError(msg);
				break;
			}
			outerfuture.setException(exception);
			Log.log("Error in CheckCredentials: ", exception.toString());
			return; //don't run other thens.
		}
	});

	future.then(this, function updateCredentialsCB() {
		var result = checkResult(future);
		Log.debug("------------->Modified Key: ", result);

		if (this.config) {
			this.config.accountId = args.accountId || this.config.accountId;
			this.config.name = name || this.config.name;
			this.config.url = url || this.config.url;
			this.config.urlScheme = urlScheme || this.config.urlScheme;
			this.config.ignoreSSLCertificateErrors = !!args.ignoreSSLCertificateErrors;

			if (this.config._id && this.config._kind) {
				future.nest(DB.merge([this.config]));
			} else {
				Log.log("Did not have config object in DB. Won't put new one to prevent duplicates.");
				buildResult();
			}
		} else {
			Log.log("No config found => can't save it.");
			buildResult();
		}
	});

	future.then(this, function mergeCB() {
		var result = checkResult(future.result);
		Log.log("Stored config in config db: ", result);
		buildResult();
	});

	return outerfuture;
};
