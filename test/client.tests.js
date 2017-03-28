const LimitdClient = require('../');
const MockServer = require('./MockServer');
const assert = require('chai').assert;
const ShardClient = require('../shard_client');

const _ = require('lodash');

describe('limitd client (standard)', function () {
  var server, client;

  before(function (done) {
    server = new MockServer();
    server.listen(done);
  });

  before(function (done) {
    client = new LimitdClient({ protocol_version: 2 });
    client.once('connect', done);
  });

  after(function (done) {
    client.disconnect();
    server.close(done);
  });

  it('should return an instance of ShardClient when initializing with shard', function() {
    const client  = new LimitdClient({ shard: {hosts: ['limitd://localhost:9231'] }});
    assert.instanceOf(client, ShardClient);
  });

  ['take', 'wait'].forEach(function (method) {

    it('should be able to send ' + method.toUpperCase() + ' requests', function (done) {
      server.once('request', function (request) {
        assert.isNumber(request.id);
        assert.equal(request.method, method.toUpperCase());
        assert.equal(request.type, 'ip');
        assert.equal(request.count, 1);
        assert.equal(request.all, false);
        done();
      });

      client[method]('ip', '191.12.23.32', 1);
    });
  });

  it('should be able to send PING requests', function (done) {
    server.once('request', function (request) {
      assert.isNumber(request.id);
      assert.equal(request.method, 'PING');
      done();
    });

    client.ping(_.noop);
  });

  it('should be able to send PUT requests', function (done) {
    server.once('request', function (request) {
      assert.isNumber(request.id);

      assert.equal(request.method, 'PUT');
      assert.equal(request.type, 'ip');
      assert.equal(request.all, true);
      assert.notOk(request.skipResponse);

      done();
    });

    client.put('ip', '191.12.23.32', _.noop);
  });


  it('should be able to send callback-less PUT requests', function (done) {
    server.once('request', function (request) {
      assert.isNumber(request.id);

      assert.equal(request.method, 'PUT');
      assert.equal(request.type, 'ip');
      assert.equal(request.all, true);
      assert.equal(request.skipResponse, true);

      done();
    });

    client.put('ip', '191.12.23.32');
  });

  it('should be able to send status requests', function (done) {
    server.once('request', function (request) {
      assert.isNumber(request.id);

      assert.equal(request.method, 'STATUS');
      assert.equal(request.type, 'ip');

      done();
    });

    client.status('ip', '191.12.23.32', function () {});
  });

  it('should send type "" if undefined', function (done) {
    server.once('request', function (request) {
      assert.isNumber(request.id);
      assert.equal(request.method, 'STATUS');
      assert.equal(request.type, 'ip');
      assert.equal(request.key, '');

      done();
    });

    client.status('ip', undefined, function () {});
  });

  it('should be able to parse the response of TAKE', function (done) {

    server.once('request', function (request, reply) {
      const response = {
        request_id: request.id,
        'take': {
          conformant: true,
          remaining:  10,
          reset:      11111111,
          limit:      100
        }
      };

      reply(response);
    });

    client.take('ip', '191.12.23.32', 1, function (err, response) {
      if (err) return done(err);
      assert.ok(response.conformant);
      assert.notOk(response.delayed);
      assert.equal(response.remaining, 10);
      assert.equal(response.reset, 11111111);
      assert.equal(response.limit, 100);
      done();
    });
  });

  it('should be able to parse the Error Responses', function (done) {

    server.once('request', function (request, reply) {
      const response = {
        request_id: request.id,
        'error': {
          type: 'UNKNOWN_BUCKET_TYPE'
        }
      };

      reply(response);
    });

    client.take('ip', '191.12.23.32', 1, function (err) {
      assert.ok(err);
      assert.equal(err.message, 'Invalid bucket type');
      done();
    });
  });


  it('should timeout a request when there is no response from the server', function (done) {
    server.once('request', function () {
      //noop
    });

    client.take('ip', '191.timeout.23.32', 1, function (err){
      assert.ok(err);
      assert.match(err.message, /timeout/);
      done();
    });
  });

});
