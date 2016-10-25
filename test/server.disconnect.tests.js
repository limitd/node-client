const MockServer = require('./MockServer');
const LimitdClient = require('../');
const port = 23312;
const assert = require('chai').assert;

describe('circuit breaker', function () {
  it('should fail fast once we reach the threashold', function (done) {
    const server = new MockServer({ port });
    const breaker_errors = [];

    server.once('request', () => {}).listen(function () {
      var client = new LimitdClient({
        hosts: [`limitd://localhost:${port}`],
        breaker: {
          timeout: 100,
          maxFailures: 1,
        }
      }, function () {
        client.once('breaker_error', (err) => breaker_errors.push(err));

        client.take('ip', '1232.312.error', 1, function (err1) {
          assert.equal(err1.message, 'limitd.request: specified timeout of 100ms was reached');
          client.take('ip', '1232.312.error', 1, function (err2) {
            assert.equal(err2.message, 'limitd.request: the circuit-breaker is open');
            assert.equal(breaker_errors.length, 1);
            assert.equal(breaker_errors[0], err1);
            done();
          });
        });
      });
    });
  });
});
