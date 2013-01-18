/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * test/services.test.js: test /services endpoints
 */

var async = require('async');
var common = require('./common');
var jsprim = require('jsprim');
var node_uuid = require('node-uuid');

if (require.cache[__dirname + '/helper.js'])
	delete require.cache[__dirname + '/helper.js'];
var helper = require('./helper.js');
var test = helper.test;


var URI = '/services';


// -- Tests

helper.before(function (cb) {
	this.client = helper.createJsonClient();
	this.sapi = helper.createSapiClient();

	cb();
});

helper.after(function (cb) {
	cb();
});


// -- Test invalid inputs

test('create w/ missing inputs', function (t) {
	var self = this;

	var svc = {};
	svc.name = 'application_uuid missing';
	svc.application_uuid = node_uuid.v4();

	svc.params = {};
	svc.params.image_uuid = common.SMARTOS_163_UUID;
	svc.params.ram = 256;
	svc.params.networks = [ 'admin' ];

	function check409(err, res) {
		t.ok(err);
		t.equal(err.name, 'MissingParameterError');
		t.equal(res.statusCode, 409);
	}

	async.waterfall([
		function (cb) {
			var badsvc = jsprim.deepCopy(svc);
			delete badsvc.name;

			self.client.post(URI, badsvc, function (err, _, res) {
				check409(err, res);
				cb();
			});
		},
		function (cb) {
			var badsvc = jsprim.deepCopy(svc);
			delete badsvc.application_uuid;

			self.client.post(URI, badsvc, function (err, _, res) {
				check409(err, res);
				cb();
			});
		}
	], function (err) {
		t.end();
	});
});

test('create w/ invalid application_uuid', function (t) {
	var svc = {};
	svc.name = 'invalid application_uuid';
	svc.application_uuid = node_uuid.v4();  // invalid

	svc.params = {};
	svc.params.image_uuid = common.SMARTOS_163_UUID;
	svc.params.ram = 256;
	svc.params.networks = [ 'admin' ];

	this.client.post('/services', svc, function (err, req, res, obj) {
		t.ok(err);
		t.equal(res.statusCode, 500);
		t.end();
	});
});

test('create w/ other invalid inputs', function (t) {
	var self = this;

	var app_uuid = node_uuid.v4();

	var svc = {};
	svc.name = 'invalid inputs';
	svc.application_uuid = app_uuid;

	svc.params = {};
	svc.params.image_uuid = common.SMARTOS_163_UUID;
	svc.params.ram = 256;
	svc.params.networks = [ 'admin' ];

	async.waterfall([
		function (cb) {
			common.createApplication.call(self, app_uuid, cb);
		},
		function (cb) {
			// invalid image_uuid
			var badsvc = jsprim.deepCopy(svc);
			badsvc.params.image_uuid = node_uuid.v4();

			self.client.post(URI, badsvc, function (err, _, res) {
				t.ok(err);
				t.equal(res.statusCode, 500);
				cb();
			});
		},
		function (cb) {
			// invalid config manifest
			var badsvc = jsprim.deepCopy(svc);
			badsvc.configs = [ node_uuid.v4() ];

			self.client.post(URI, badsvc, function (err, _, res) {
				t.ok(err);
				t.equal(res.statusCode, 500);
				cb();
			});
		},
		function (cb) {
			self.sapi.deleteApplication(app_uuid, cb);
		}
	], function (err) {
		t.end();
	});
});

test('get nonexistent service', function (t) {
	var uri_svc = '/services/' + node_uuid.v4();

	this.client.get(uri_svc, function (err, req, res, obj) {
		t.ok(err);
		t.equal(res.statusCode, 404);
		t.end();
	});
});


// -- Test a standard put/get/del service

test('put/get/del service', function (t) {
	var self = this;


	var app_uuid = node_uuid.v4();

	var svc = {};
	svc.name = 'mycoolservice';
	svc.uuid = node_uuid.v4();
	svc.application_uuid = app_uuid;

	svc.params = {};
	svc.params.image_uuid = common.SMARTOS_163_UUID;
	svc.params.ram = 256;
	svc.params.networks = [ 'admin' ];

	svc.metadata = {
		dns: '10.0.0.2',
		domain: 'foo.co.us',
		vmapi: {
			url: 'https://10.0.0.10'
		}
	};

	var cfg_uuid;

	var checkService = function (obj) {
		t.equal(obj.name, svc.name);
		t.equal(obj.uuid, svc.uuid);
		t.deepEqual(obj.params, svc.params);
		t.deepEqual(obj.metadata, svc.metadata);
		t.deepEqual(obj.configs, [ cfg_uuid ]);
	};

	var uri_svc = '/services/' + svc.uuid;

	async.waterfall([
		function (cb) {
			common.createApplication.call(self, app_uuid, cb);
		},
		function (cb) {
			common.createConfig.call(self, function (err, cfg) {
				if (cfg) {
					cfg_uuid = cfg.uuid;
					svc.configs = [ cfg_uuid ];
				}
				cb(err);
			});
		},
		function (cb) {
			self.client.get(uri_svc, function (err, _, res, obj) {
				t.ok(err);
				t.equal(res.statusCode, 404);
				cb();
			});
		},
		function (cb) {
			self.client.post(URI, svc, function (err, _, res, obj) {
				t.ifError(err);
				t.equal(res.statusCode, 200);

				checkService(obj);

				cb();
			});
		},
		function (cb) {
			self.client.get(uri_svc, function (err, _, res, obj) {
				t.ifError(err);
				t.equal(res.statusCode, 200);

				checkService(obj);

				cb();
			});
		},
		function (cb) {
			self.client.get(URI, function (err, _, res, obj) {
				t.ifError(err);
				t.equal(res.statusCode, 200);

				t.ok(obj.length > 0);

				var found = false;

				for (var ii = 0; ii < obj.length; ii++) {
					if (obj[ii].uuid === svc.uuid) {
						checkService(obj[ii]);
						found = true;
					}
				}

				t.ok(found, 'found service' + svc.uuid);

				cb();
			});
		},
		function (cb) {
			self.client.del(uri_svc, function (err, _, res, obj) {
				t.ifError(err);
				t.equal(res.statusCode, 204);
				cb();
			});
		},
		function (cb) {
			self.client.get(uri_svc, function (err, _, res, obj) {
				t.ok(err);
				t.equal(res.statusCode, 404);
				cb();
			});
		},
		function (cb) {
			self.sapi.deleteConfig(cfg_uuid, function (err) {
				cb(err);
			});
		},
		function (cb) {
			self.sapi.deleteApplication(app_uuid, function (err) {
				cb(err);
			});
		}
	], function (err, results) {
		t.end();
	});
});
