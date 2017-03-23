const LimitdClient = require('../');
const MockServer = require('./MockServer');
const assert = require('chai').assert;

const _ = require('lodash');

describe('protocol negotiation', function () {
  var server, client;

  before(function (done) {
    server = new MockServer();
    server.listen(done);
  });

  before(function (done) {
    client = new LimitdClient({});
    client.once('connect', done);
  });

  after(function (done) {
    client.disconnect();
    server.close(done);
  });

  it('should be able to parse the response of TAKE', function (done) {

    server.on('request', function (request, reply) {
      if (request.method === 'PING') {
        assert.isString(request.id);
        const response = {
          request_id: request.id,
          'pong': {
            protocol_version: 2
          }
        };
        return reply(response);
      }

      assert.isNumber(request.id);
      done();
    });

    client.ping((err) => {
      if (err) { return done(err); }
      client.take('ip', '191.12.23.32', 1, _.noop);
    });

  });
});
