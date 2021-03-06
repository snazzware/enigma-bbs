/* jslint node: true */
'use strict';

//	ENiGMA½
const Config				= require('./config.js').config;
const FileDb				= require('./database.js').dbs.file;
const getISOTimestampString	= require('./database.js').getISOTimestampString;
const FileEntry				= require('./file_entry.js');
const getServer				= require('./listening_server.js').getServer;
const Errors				= require('./enig_error.js').Errors;
const ErrNotEnabled			= require('./enig_error.js').ErrorReasons.NotEnabled;
const StatLog				= require('./stat_log.js');
const User					= require('./user.js');
const Log					= require('./logger.js').log;
const getConnectionByUserId	= require('./client_connections.js').getConnectionByUserId;
const webServerPackageName	= require('./servers/content/web.js').moduleInfo.packageName;

//	deps
const hashids		= require('hashids');
const moment		= require('moment');
const paths			= require('path');
const async			= require('async');
const fs			= require('graceful-fs');
const mimeTypes		= require('mime-types');
const _				= require('lodash');

	/*
		:TODO:
		* Load temp download URLs @ startup & set expire timers via scheduler.
		* At creation, set expire timer via scheduler
		* 
	*/

function notEnabledError() {
	return Errors.General('Web server is not enabled', ErrNotEnabled);
}

class FileAreaWebAccess {
	constructor() {
		this.hashids		= new hashids(Config.general.boardName);
		this.expireTimers	= {};	//	hashId->timer
	}

	startup(cb) {
		const self = this;

		async.series(
			[
				function initFromDb(callback) {
					return self.load(callback);
				},
				function addWebRoute(callback) {
					self.webServer = getServer(webServerPackageName);
					if(!self.webServer) {
						return callback(Errors.DoesNotExist(`Server with package name "${webServerPackageName}" does not exist`));
					}

					if(self.isEnabled()) {
						const routeAdded = self.webServer.instance.addRoute({
							method	: 'GET',
							path	: Config.fileBase.web.routePath,
							handler	: self.routeWebRequestForFile.bind(self),
						});
						return callback(routeAdded ? null : Errors.General('Failed adding route'));
					} else {
						return callback(null);	//	not enabled, but no error
					}
				}
			], 
			err => {
				return cb(err);
			}
		);
	}

	shutdown(cb) {
		return cb(null);
	}

	isEnabled() {
		return this.webServer.instance.isEnabled();
	}

	load(cb) {
		//
		//	Load entries, register expiration timers
		//
		FileDb.each(
			`SELECT hash_id, expire_timestamp
			FROM file_web_serve;`,
			(err, row) => {
				if(row) {
					this.scheduleExpire(row.hash_id, moment(row.expire_timestamp));
				}
			},
			err => {
				return cb(err);
			}
		);
	}

	removeEntry(hashId) {
		//
		//	Delete record from DB, and our timer
		//
		FileDb.run(
			`DELETE FROM file_web_serve
			WHERE hash_id = ?;`,
			[ hashId ]
		);

		delete this.expireTimers[hashId];
	}

	scheduleExpire(hashId, expireTime) {

		//	remove any previous entry for this hashId
		const previous = this.expireTimers[hashId];
		if(previous) {
			clearTimeout(previous);
			delete this.expireTimers[hashId];
		}

		const timeoutMs = expireTime.diff(moment());

		if(timeoutMs <= 0) {
			setImmediate( () => {
				this.removeEntry(hashId);
			});
		} else {
			this.expireTimers[hashId] = setTimeout( () => {
				this.removeEntry(hashId);
			}, timeoutMs);
		}
	}

	loadServedHashId(hashId, cb) {
		FileDb.get(
			`SELECT expire_timestamp FROM
			file_web_serve
			WHERE hash_id = ?`,
			[ hashId ],
			(err, result) => {
				if(err) {
					return cb(err);
				}

				const decoded = this.hashids.decode(hashId);
				if(!result || 2 !== decoded.length) {
					return cb(Errors.Invalid('Invalid or unknown hash ID'));
				}

				return cb(
					null,
					{
						hashId			: hashId,
						userId			: decoded[0],
						fileId			: decoded[1],
						expireTimestamp	: moment(result.expire_timestamp),
					}
				);
			}
		);
	}

	getHashId(client, fileEntry) {
		//
		//	Hashid is a unique combination of userId & fileId
		//
		return this.hashids.encode(client.user.userId, fileEntry.fileId);
	}

	buildTempDownloadLink(client, fileEntry, hashId) {		
		hashId = hashId || this.getHashId(client, fileEntry);

		return this.webServer.instance.buildUrl(`${Config.fileBase.web.path}${hashId}`);
		/*
			
		//
		//	Create a URL such as
		//	https://l33t.codes:44512/f/qFdxyZr
		//
		//	Prefer HTTPS over HTTP. Be explicit about the port
		//	only if non-standard.
		//		
		let schema;
		let port;
		if(_.isString(Config.contentServers.web.overrideUrlPrefix)) {
			return `${Config.contentServers.web.overrideUrlPrefix}${Config.fileBase.web.path}${hashId}`;
		} else {
			if(Config.contentServers.web.https.enabled) {
				schema	= 'https://';
				port	=  (443 === Config.contentServers.web.https.port) ?
					'' :
					`:${Config.contentServers.web.https.port}`;
			} else {
				schema	= 'http://';
				port	= (80 === Config.contentServers.web.http.port) ?
					'' :
					`:${Config.contentServers.web.http.port}`;
			}
			
			return `${schema}${Config.contentServers.web.domain}${port}${Config.fileBase.web.path}${hashId}`;
		}
		*/
	}

	getExistingTempDownloadServeItem(client, fileEntry, cb) {
		if(!this.isEnabled()) {
			return cb(notEnabledError());
		}	

		const hashId = this.getHashId(client, fileEntry);
		this.loadServedHashId(hashId, (err, servedItem) => {
			if(err) {
				return cb(err);
			}

			servedItem.url = this.buildTempDownloadLink(client, fileEntry); 

			return cb(null, servedItem);
		});		
	}

	createAndServeTempDownload(client, fileEntry, options, cb) {
		if(!this.isEnabled()) {
			return cb(notEnabledError());
		}

		const hashId		= this.getHashId(client, fileEntry);
		const url			= this.buildTempDownloadLink(client, fileEntry, hashId);		
		options.expireTime	= options.expireTime || moment().add(2, 'days');

		//	add/update rec with hash id and (latest) timestamp
		FileDb.run(
			`REPLACE INTO file_web_serve (hash_id, expire_timestamp)
			VALUES (?, ?);`,
			[ hashId, getISOTimestampString(options.expireTime) ],
			err => {
				if(err) {
					return cb(err);
				}

				this.scheduleExpire(hashId, options.expireTime);
				
				return cb(null, url);
			}
		);
	}

	fileNotFound(resp) {
		return this.webServer.instance.fileNotFound(resp);
	}

	routeWebRequestForFile(req, resp) {
		const hashId = paths.basename(req.url);

		this.loadServedHashId(hashId, (err, servedItem) => {

			if(err) {
				return this.fileNotFound(resp);
			}

			const fileEntry = new FileEntry();
			fileEntry.load(servedItem.fileId, err => {
				if(err) {
					return this.fileNotFound(resp);
				}

				const filePath = fileEntry.filePath;
				if(!filePath) {
					return this.fileNotFound(resp);
				}

				fs.stat(filePath, (err, stats) => {
					if(err) {
						return this.fileNotFound(resp);
					}

					resp.on('close', () => {
						//	connection closed *before* the response was fully sent
						//	:TODO: Log and such
					});

					resp.on('finish', () => {
						//	transfer completed fully
						this.updateDownloadStatsForUserId(servedItem.userId, stats.size);
					});

					const headers = {
						'Content-Type'			: mimeTypes.contentType(filePath) || mimeTypes.contentType('.bin'),
						'Content-Length'		: stats.size,
						'Content-Disposition'	: `attachment; filename="${fileEntry.fileName}"`, 
					};

					const readStream = fs.createReadStream(filePath);
					resp.writeHead(200, headers);
					return readStream.pipe(resp);
				});
			});									
		});
	}

	updateDownloadStatsForUserId(userId, dlBytes, cb) {
		async.waterfall(
			[
				function fetchActiveUser(callback) {
					const clientForUserId = getConnectionByUserId(userId);
					if(clientForUserId) {
						return callback(null, clientForUserId.user);
					}

					//	not online now - look 'em up
					User.getUser(userId, (err, assocUser) => {
						return callback(err, assocUser);
					});
				},
				function updateStats(user, callback) {
					StatLog.incrementUserStat(user, 'dl_total_count', 1);
					StatLog.incrementUserStat(user, 'dl_total_bytes', dlBytes);
					StatLog.incrementSystemStat('dl_total_count', 1);
					StatLog.incrementSystemStat('dl_total_bytes', dlBytes);
					
					return callback(null);
				}
			],
			err => {
				if(cb) {
					return cb(err);
				}
			}
		);
	}
}

module.exports = new FileAreaWebAccess();