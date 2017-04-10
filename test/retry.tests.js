const MockServer = require('./MockServer');
const LimitdClient = require('../');
const port = 54325;
const assert = require('chai').assert;

describe('retry errors', function () {
  const server = new MockServer({ port });
  var client;

  before(done => server.listen(done));

  beforeEach(done => {
    server.removeAllListeners('request');
    client = new LimitdClient({
      hosts: [`limitd://localhost:${port}`],
    }, done);
  });

  it('should not retry UNKNOWN_BUCKET_TYPE errors', function (done) {
    var times = 0;

    server.on('request', function handler(request, reply) {
      times++;
      const response = {
        request_id: request.id,
        'error': {
          type: 'UNKNOWN_BUCKET_TYPE'
        }
      };
      reply(response);
    });


    client.take('ip', '1232.312.error', 1, function (err) {
      assert.equal(times, 1);
      assert.equal(err.message, 'Invalid bucket type');
      done();
    });
  });


  it('should retry on timeout', function(done) {
    var times = 0;

    server.on('request', () => times++);

    client.take('ip', '1232.312.error', function (err) {
      assert.equal(times, 4);
      assert.match(err.message, /timeout/);
      done();
    });
  });
});
