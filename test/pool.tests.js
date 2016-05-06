var _         = require('lodash');
var assert    = require('assert');
var protocol  = require('../lib/protocol');
var LimitdClient  = require('../');
var MockServer    = require('./MockServer');

var PORT = 9231;

describe('limitd client pool', function() {

  var server = [];

  // start three services
  beforeEach((done) => {
    server = new MockServer({ port: PORT });
    server.listen(function () {
      done();
    });
  });

  afterEach(() => {
    server.close();
  });

  it('should connect to server', function(done) {

    server.once('request', function (request) {
      assert.equal(typeof request.id, 'string');
      assert.equal(request.method, protocol.Request.Method.TAKE);
      assert.equal(request.type, 'ip');
      assert.equal(request.count, 1);
      assert.equal(request.all, false);
      done();
    });

    // invoke service
    var pool = new LimitdClient.Pool('limitd://localhost:' + PORT);
    pool.on('ready', function() {
      pool.take('ip', '191.12.23.32', 1);
    });
  });

  it('should return error on callback if no connection is available', function(done) {
    var pool = new LimitdClient.Pool('limitd://localhost:4321');
    // it will never emit ready because it will try to reconnect the clients
    // indefinitely
    setTimeout(function() {
      pool.take('ip', '191.12.23.32', 1, function(err) {
        assert.equal(err.message, 'The socket is closed.');
        done();
      });
    }, 1000);
  });
});
