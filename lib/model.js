/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * lib/model.js: SAPI's data model and associated operations on those objects.
 */

var async = require('async');
var assert = require('assert-plus');
var moray = require('moray');
var sdc = require('sdc-clients');
var node_uuid = require('node-uuid');
var vasync = require('vasync');

var sprintf = require('util').format;

var APPLICATIONS = 'sapi_applications';
var SERVICES = 'sapi_services';
var INSTANCES = 'sapi_instances';


// -- Constructor and initialization routines

function Model(config) {
	this.config = config;
	this.log = config.log;

	assert.object(config, 'config');

	assert.object(config.moray, 'config.moray');
	assert.string(config.moray.host, 'config.moray.host');

	assert.object(config.ufds, 'config.ufds');
	assert.string(config.ufds.url, 'config.ufds.url');
	assert.string(config.ufds.bindDN, 'config.ufds.bindDN');
	assert.string(config.ufds.bindPassword, 'config.ufds.bindPassword');

	assert.object(config.vmapi, 'config.vmapi');
	assert.string(config.vmapi.url, 'config.vmapi.url');

	assert.object(config.imgapi, 'config.imgapi');
	assert.string(config.imgapi.url, 'config.imgapi.url');

	config.moray.log = this.log;
	config.ufds.log = this.log;
	config.vmapi.log = this.log;
	config.imgapi.log = this.log;

	config.moray.noCache = true;
	config.moray.connectTimeout = 10000;
	config.moray.retry = {};
	config.moray.retry.retries = Infinity;
	config.moray.retry.minTimeout = 1000;
	config.moray.retry.maxTimeout = 60000;
}

Model.prototype.initClients = function (cb) {
	var self = this;
	var config = self.config;

	self.moray = moray.createClient(config.moray);
	self.ufds = new sdc.UFDS(config.ufds);
	self.vmapi = new sdc.VMAPI(config.vmapi);
	self.imgapi = new sdc.IMGAPI(config.imgapi);

	self.moray.on('connect', function () {
		return (cb(null));
	});
};

Model.prototype.initBuckets = function (cb) {
	var self = this;

	var cfg = {
		index: {
			uuid: {
				type: 'string',
				unique: true
			}
		}
	};

	vasync.forEachParallel({
		func: function (bucket, subcb) {
			createBucket.call(self, bucket, cfg, subcb);
		},
		inputs: [ APPLICATIONS, SERVICES, INSTANCES ]
	}, function (err, results) {
		return (cb(err));
	});
};



// -- Helper functions

function validOwnerUUID(owner_uuid, cb) {
	var self = this;
	var log = self.log;

	assert.string(owner_uuid, 'owner_uuid');

	self.ufds.getUser(owner_uuid, function (err, user) {
		if (err) {
			log.error(err, 'failed to lookup user %s', owner_uuid);
			return (cb(null, false));
		}

		log.info({ user: user }, 'found owner_uuid %s', owner_uuid);

		return (cb(null, true));
	});
}

function createBucket(name, cfg, cb) {
	var self = this;
	var log = self.log;

	self.moray.getBucket(name, function (err, bucket) {
		if (!err)
			return (cb(null));

		if (err && err.name !== 'BucketNotFoundError') {
			log.error(err, 'failed to get bucket %s', name);
			return (cb(err));
		}

		self.moray.createBucket(name, cfg, function (suberr) {
			if (suberr) {
				log.error(suberr,
				    'failed to create bucket %s', name);
				return (cb(
				    new Error('failed to create bucket')));
			}

			log.info('created bucket %s', name);

			return (cb(null));
		});

		return (null);
	});
}

function findObjects(bucket, filter, cb) {
	var self = this;
	var log = self.log;

	var res = self.moray.findObjects(bucket, filter, {});

	var objs = [];

	res.on('record', function (record) {
		objs.push(record.value);
	});

	res.on('error', function (err) {
		log.error(err, 'failed to list objects from bucket %s', bucket);
		return (cb(err));
	});

	res.on('end', function () {
		return (cb(null, objs));
	});
}

function listObjects(bucket, cb) {
	var self = this;

	findObjects.call(self, bucket, '(uuid=*)', cb);
}

function getObject(bucket, uuid, cb) {
	var self = this;
	var log = self.log;

	var filter = sprintf('(uuid=%s)', uuid);

	findObjects.call(self, bucket, filter, function (err, objs) {
		if (err) {
			log.error(err, 'failed to find object %s', uuid);
			cb(err);
		} else {
			cb(null, objs.length > 0 ? objs[0] : null);
		}
	});
}



// -- Applications

/*
 * Create an application.  An application consists of an name and owner_uuid.
 */
Model.prototype.createApplication = function (app, cb) {
	var self = this;
	var log = self.log;

	assert.object(app, 'app');
	assert.string(app.name, 'app.name');
	assert.string(app.owner_uuid, 'app.owner_uuid');

	/*
	 * If the caller hasn't provided a UUID, generate one here.
	 */
	if (!app.uuid) {
		app.uuid = node_uuid.v4();
	}

	async.waterfall([
		function (subcb) {
			validOwnerUUID.call(self, app.owner_uuid,
			    function (err, valid) {
				subcb(valid ? null : new Error(
				    'invalid user: ' + app.owner_uuid));
			});
		},

		function (subcb) {
			self.moray.putObject(APPLICATIONS, app.uuid, app,
			    function (err) {
				if (err) {
					log.error(err, 'failed to put ' +
					    'application %s', app.name);
					return (subcb(err));
				}

				return (subcb(null));
			});
		}

	], function (err, result) {
		log.info({ app: app }, 'created application');
		cb(err, app);
	});
};

Model.prototype.listApplications = function (cb) {
	listObjects.call(this, APPLICATIONS, cb);
};

Model.prototype.getApplication = function (uuid, cb) {
	getObject.call(this, APPLICATIONS, uuid, cb);
};

Model.prototype.delApplication = function (uuid, cb) {
	var self = this;
	self.moray.delObject(APPLICATIONS, uuid, {}, cb);
};



// -- Services

/*
 * Create a service.
 */
Model.prototype.createService = function (service, cb) {
	var self = this;
	var log = self.log;

	assert.object(service, 'service');
	assert.string(service.name, 'service.name');
	assert.string(service.application_uuid, 'service.application_uuid');
	assert.string(service.image_uuid, 'service.image_uuid');

	/*
	 * If the caller hasn't provided a UUID, generate one here.
	 */
	if (!service.uuid)
		service.uuid = node_uuid.v4();

	async.waterfall([
		function (subcb) {
			var app_uuid = service.application_uuid;

			self.getApplication(app_uuid, function (err, app) {
				if (err || !app) {
					var msg = sprintf('application %s ' +
					    'doesn\'t exist', app_uuid);
					log.error(err, msg);
					return (subcb(new Error(msg)));
				}

				return (subcb(null));
			});
		},
		function (subcb) {
			var image_uuid = service.image_uuid;

			self.imgapi.getImage(image_uuid, function (err, image) {
				if (err || !image) {
					var msg = sprintf('image %s ' +
					    'doesn\'t exist', image_uuid);
					log.error(err, msg);
					return (subcb(new Error(msg)));
				}

				return (subcb(null));
			});
		},
		function (subcb) {
			self.moray.putObject(SERVICES, service.uuid, service,
			    function (err) {
				if (err) {
					log.error(err, 'failed to put ' +
					    'service %s', service.name);
					return (subcb(err));
				}

				return (subcb(null));
			});
		}
	], function (err, result) {
		if (!err)
			log.info({ service: service }, 'created service');
		cb(err, service);
	});
};

Model.prototype.listServices = function (cb) {
	listObjects.call(this, SERVICES, cb);
};

Model.prototype.getService = function (uuid, cb) {
	getObject.call(this, SERVICES, uuid, cb);
};

Model.prototype.delService = function (uuid, cb) {
	var self = this;
	self.moray.delObject(SERVICES, uuid, {}, cb);
};



// -- Instances

/*
 * Create a instance.
 */
Model.prototype.createInstance = function (instance, cb) {
	var self = this;
	var log = self.log;

	assert.object(instance, 'instance');
	assert.string(instance.name, 'instance.name');
	assert.string(instance.service_uuid, 'instance.service_uuid');

	/*
	 * If the caller hasn't provided a UUID, generate one here.
	 */
	if (!instance.uuid)
		instance.uuid = node_uuid.v4();

	async.waterfall([
		function (subcb) {
			var svc_uuid = instance.service_uuid;

			self.getService(svc_uuid, function (err, svc) {
				if (err || !svc) {
					var msg = sprintf('service %s ' +
					    'doesn\'t exist', svc_uuid);
					log.error(err, msg);
					return (subcb(new Error(msg)));
				}

				return (subcb(null));
			});
		},
		function (subcb) {
			self.moray.putObject(INSTANCES, instance.uuid, instance,
			    function (err) {
				if (err) {
					log.error(err, 'failed to put ' +
					    'instance %s', instance.name);
					return (subcb(err));
				}

				return (subcb(null));
			});
		}
	], function (err, result) {
		if (!err)
			log.info({ instance: instance }, 'created instance');
		cb(err, instance);
	});
};

Model.prototype.listInstances = function (cb) {
	listObjects.call(this, INSTANCES, cb);
};

Model.prototype.getInstance = function (uuid, cb) {
	getObject.call(this, INSTANCES, uuid, cb);
};

Model.prototype.delInstance = function (uuid, cb) {
	var self = this;
	self.moray.delObject(INSTANCES, uuid, {}, cb);
};


/*
 * Deploy a particular zone with conforms to the properties of the specified
 * application, service, and instance.  The zone's parameters are determined
 * first by the parameters of its application, then by the parameters of its
 * service, and finally by the parameters of its instance.
 */
function assembleParams(app, svc, inst) {
	var self = this;
	var log = self.log;

	var params = {};

	if (app.params) {
		Object.keys(app.params).forEach(function (key) {
			params[key] = app.params[key];
		});
	}
	if (svc.params) {
		Object.keys(svc.params).forEach(function (key) {
			params[key] = svc.params[key];
		});
	}
	if (inst.params) {
		Object.keys(inst.params).forEach(function (key) {
			params[key] = inst.params[key];
		});
	}

	assert.string(app.owner_uuid, 'app.owner_uuid');
	params.owner_uuid = app.owner_uuid;

	assert.string(svc.image_uuid, 'svc.image_uuid');
	params.image_uuid = svc.image_uuid;

	assert.string(inst.uuid, 'inst.uuid');
	params.uuid = inst.uuid;

	log.info({ params: params }, 'assembled parameters for zone');

	return (params);
}

function deployZone(params, cb) {
	var self = this;
	var log = self.log;

	/*
	 * SAPI only supports the joyent-minimal brand.
	 */
	params.brand = 'joyent-minimal';

	/*
	 * XXX
	 * These parameters should come from the service definition.  However,
	 * for server_uuid, that should be driven by the service's policy, not
	 * just relying on DAPI.
	 */
	params.ram = 256;
	params.networks = [ 'cda22a50-15bd-43cf-b379-be0cbac60cb4' ];
	params.server_uuid = '44454c4c-4800-1034-804a-b2c04f354d31';

	log.info({ params: params }, 'provisioning zone');

	self.vmapi.createVm(params, function (err, res) {
		if (err) {
			log.error(err, 'failed to create zone');
			return (cb(err));
		}

		return (cb(null));
	});
}

Model.prototype.deployInstance = function (instance, cb) {
	var self = this;
	var log = self.log;
	var application, service;

	assert.string(instance.service_uuid, 'instance.service_uuid');

	async.waterfall([
		function (subcb) {
			var uuid = instance.service_uuid;

			self.getService(uuid, function (suberr, result) {
				if (suberr) {
					log.error(suberr, 'failed to find ' +
					    'service %s', uuid);
					subcb(suberr);
				}

				service = result;
				assert.string(service.application_uuid);

				subcb(null);
			});
		},
		function (subcb) {
			var uuid = service.application_uuid;

			self.getApplication(uuid, function (suberr, result) {
				if (suberr) {
					log.error(suberr, 'failed to find ' +
					    'applicataion %s', uuid);
					subcb(suberr);
				}

				application = result;
				subcb(null);
			});
		},
		function (subcb) {
			var opts = {};
			opts.application = application;
			opts.service = service;
			opts.instance = instance;

			var params = assembleParams.call(self,
			    application, service, instance);

			deployZone.call(self, params, subcb);
		}
	], function (err, results) {
		if (err) {
			log.error(err, 'failed to deploy instance');
			cb(err);
		} else {
			cb(null);
		}
	});
};


module.exports = Model;