const MockServer = require('./MockServer');
const LimitdClient = require('../');
const port = 54115;
const assert = require('chai').assert;

describe('epipe errors', function () {
  const server = new MockServer({ port });
  var client;

  before(done => server.listen(done));

  beforeEach(done => {
    server.removeAllListeners('request');
    client = new LimitdClient({
      hosts: [`limitd://localhost:${port}`],
    }, done);
  });

  beforeEach(done => {
    client = new LimitdClient({
      hosts: [`limitd://localhost:${port}`],
      retry: false,
      timeout: 1000000
    }, done);
  });


  it('should emit the error on the client', function(done) {
    client.on('error', (err) => {
      assert.equal(err.message, 'fire');
      done();
    });
    client.stream.emit('close');
    client.stream.emit('error', new Error('fire'));
  });
});
