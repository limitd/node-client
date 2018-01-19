const LimitdClient = require('../');
const MockServer = require('./MockServer');

describe('disconnect tests', function () {
  it('emit disconnects', (done) => {
    const server = new MockServer();
    server.listen(() => {
      const client = new LimitdClient({ protocol_version: 2 });
      client.socket.reconnect = false;
      client
        .once('disconnect', () => done())
        .once('connect', () => server.close());
    });
  });

  it('emit connect everytime it connects', (done) => {
    const server = new MockServer();
    var connectTimes = 0;

    const client = new LimitdClient({ protocol_version: 2 });

    client.on('connect', () => {
      connectTimes++;
      if (connectTimes === 1) {
        server.close(() => server.listen());
      } else if (connectTimes === 2) {
        server.close(done);
        client.disconnect();
      }
    });

    server.listen();
  });

});
