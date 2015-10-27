var LimitdClient = require('../');
var MockServer = require('./MockServer');
var assert = require('chai').assert;
var protocol = require('../lib/protocol');

var Response = protocol.Response;
var TakeResponse = protocol.TakeResponse;
var ErrorResponse = protocol.ErrorResponse;

describe('limitd client', function () {
  var server, client;

  before(function (done) {
    server = new MockServer();
    server.listen(done);
  });

  before(function (done) {
    client = new LimitdClient();
    client.once('connect', done);
  });

  after(function (done) {
    client.disconnect();
    server.close(done);
  });

  ['take', 'wait'].forEach(function (method) {

    it('should be able to send ' + method.toUpperCase() + ' requests', function (done) {
      server.once('request', function (request) {
        assert.isString(request.id);

        assert.equal(request.method, protocol.Request.Method[method.toUpperCase()]);
        assert.equal(request.type, 'ip');
        assert.equal(request.count, 1);
        assert.equal(request.all, false);
        done();
      });

      client[method]('ip', '191.12.23.32', 1);
    });

  });


  it('should be able to send PUT requests', function (done) {
    server.once('request', function (request) {
      assert.isString(request.id);

      assert.equal(request.method, protocol.Request.Method.PUT);
      assert.equal(request.type, 'ip');
      assert.equal(request.all, true);

      done();
    });

    client.put('ip', '191.12.23.32');
  });

  it('should be able to send status requests', function (done) {
    server.once('request', function (request) {
      assert.isString(request.id);

      assert.equal(request.method, protocol.Request.Method.STATUS);
      assert.equal(request.type, 'ip');

      done();
    });

    client.status('ip', '191.12.23.32', function () {});
  });

  it('should be able to parse the response of TAKE', function (done) {

    server.once('request', function (request, reply) {
      var response = new Response({
        request_id: request.id,
        type: Response.Type.TAKE
      });

      var takeResponse = new TakeResponse({
        conformant: true,
        remaining:  10,
        reset:      11111111,
        limit:      100
      });

      response.set('.limitd.TakeResponse.response', takeResponse);

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
      var response = new Response({
        request_id: request.id,
        type: Response.Type.ERROR
      });

      var errorResponse = new ErrorResponse({
        type: ErrorResponse.Type.UNKNOWN_BUCKET_TYPE
      });

      response.set('.limitd.ErrorResponse.response', errorResponse);

      reply(response);
    });

    client.take('ip', '191.12.23.32', 1, function (err, response) {
      assert.ok(err);
      assert.equal(err.message, 'ip is not a valid bucket type');
      done();
    });
  });


});