const MockServer = require('./MockServer');
const MockDecoder = require('./MockDecoder');
const $require = require('proxyquire').noPreserveCache();

const mockDecoder = new MockDecoder();
const LimitdClient = $require('../Client', {
  'length-prefixed-stream': {
    decode: () => {
      return mockDecoder;
    }
  }
});

const port = 54115;
const assert = require('chai').assert;

describe('error in length prefix stream decode', function () {
  const server = new MockServer({ port });
  var client;

  before(done => server.listen(done));

  beforeEach(() => {
    server.removeAllListeners('request');
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

    mockDecoder.emit('close');
    mockDecoder.emit('error', new Error('fire'));
  });
});


