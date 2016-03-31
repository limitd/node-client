var _         = require('lodash');
var assert    = require('assert');
var protocol  = require('../lib/protocol');
var LimitdClient  = require('../');
var MockServer    = require('./MockServer');

var PORT = 9231;

describe('limitd client failover', function() {

  var client;
  var servers = [];

  // start three services
  beforeEach((done) => {
    
    function createClient() {
      var config = {
        hosts: _.map(servers, (server, index) => {
          return 'limitd://localhost:' + (PORT + index);
        }),
        timeout: 3000
      };

      client = new LimitdClient(config); 
      client.once('connect', done);
    }

    var count = 3;
    servers = _.map(_.range(3), (i) => {
      var port = PORT + i;
      var server = new MockServer({ port: port });
      server.listen(function () {
        if (++i === count) {
          createClient();
        }
      });
      servers.push(server);
      return server;
    });
  });

  // close all services
  afterEach(() => {
    servers.map((server) => {
      server.close();
    });
  });

  it('should connect to first service', function(done) {

    servers[0].once('request', function (request) {
      assert.equal(typeof request.id, 'string');
      assert.equal(request.method, protocol.Request.Method.TAKE);
      assert.equal(request.type, 'ip');
      assert.equal(request.count, 1);
      assert.equal(request.all, false);
      done();
    });

    // invoke service
    client.take('ip', '191.12.23.32', 1);
  });

  it('should connect to second service when first is down', function(done) {

    servers[1].once('request', function (request) {
      assert.equal(typeof request.id, 'string');
      assert.equal(request.method, protocol.Request.Method.TAKE);
      assert.equal(request.type, 'ip');
      assert.equal(request.count, 1);
      assert.equal(request.all, false);
      done();
    });

    // stop first service
    servers[0].close(function (err) {
      assert.ok(!err);
      // invoke service
      setTimeout(client.take.bind(client), 1000, 'ip', '191.12.23.32', 1);
    });
  });

  it('should connect to first service after it is back', function(done) {

    servers[0].once('request', function (request) {
      assert.equal(typeof request.id, 'string');
      assert.equal(request.method, protocol.Request.Method.TAKE);
      assert.equal(request.type, 'ip');
      assert.equal(request.count, 1);
      assert.equal(request.all, false);
      done();
    });

    // stop first service
    servers[0].close(function (err) {
      assert.ok(!err);

      // wait a second
      setTimeout(function() {

        // restart first service
        servers[0].listen(function (err) {
          assert.ok(!err);

          // invoke service
          setTimeout(client.take.bind(client), 1000, 'ip', '191.12.23.32', 1);
        });
      }, 1000);
    });
  });

});
