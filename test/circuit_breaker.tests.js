const MockServer = require('./MockServer');
const LimitdClient = require('../');
const port = 23312;
const assert = require('chai').assert;
const async = require('async');

describe('circuit breaker', function () {
  const server = new MockServer({ port });
  var client;

  before(done => server.listen(done));

  beforeEach(done => {
    server.removeAllListeners('request');
    client = new LimitdClient({
      hosts: [`limitd://localhost:${port}`],
      breaker: {
        cooldown: 200,
        timeout: 100,
        maxFailures: 1,
      },
      retry: {
        minTimeout: 5,
        maxTimeout: 10,
      }
    }, done);
  });

  it('should not trigger on invalid bucket type errors', function (done) {
    client.once('breaker_error', (err) => {
      return done(err);
    });

    server.on('request', function handler(request, reply) {
      const response = {
        request_id: request.id,
        'error': {
          type: 'UNKNOWN_BUCKET_TYPE'
        }
      };
      reply(response);
    });


    client.take('ip', '1232.312.error', 1, function (err) {
      assert.equal(err.message, 'Invalid bucket type');
      client.take('ip', '1232.312.error', 1, function (err) {
        assert.equal(err.message, 'Invalid bucket type');
        done();
      });
    });
  });


  it('should fail fast once we reach the threashold', function (done) {
    const breaker_errors = [];

    client.once('trip', (err, failures, cooldown) => {
      breaker_errors.push({ err, failures, cooldown });
    });

    client.take('ip', '1232.312.error', function (err1) {
      assert.equal(err1.message, 'limitd.request: specified timeout of 100ms was reached');
      const startTime = Date.now();
      client.take('ip', '1232.312.error', function (err2) {
        assert.equal(err2.message, 'limitd.request: the circuit-breaker is open');
        assert.equal(breaker_errors.length, 1);
        assert.equal(breaker_errors[0].err, err1);
        assert.closeTo(Date.now() - startTime, 0, 10);
        done();
      });
    });
  });

  it('should only allow one request on half-open state', function (done) {
    client.take('ip', '1232.312.error', (err1) => {
      assert.equal(err1.message, 'limitd.request: specified timeout of 100ms was reached');

      setTimeout(() => {
        async.parallel([
          (done) => client.take('ip', 'test1', (err) => done(null, err)),
          (done) => client.take('ip', 'test2', (err) => done(null, err))
        ], (err, errs) => {
          if (err) { return done(err); }
          assert.equal(errs[0].message, 'limitd.request: specified timeout of 100ms was reached');
          assert.equal(errs[1].message, 'limitd.request: the circuit-breaker is open');
          done();
        });
      }, 205);

    });
  });

});
