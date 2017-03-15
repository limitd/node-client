const LimitdClient = require('../');
const MockServer = require('./MockServer');


function mock_response (request, reply) {

  var response = {
    request_id: request.id,
    'take': {
      conformant: true,
      remaining:  10,
      reset:      11111111,
      limit:      100
    }
  };

  reply(response);
}


describe('reconnection', function () {

  it('should work', function (done) {
    var server = new MockServer();
    var client = new LimitdClient();

    server.listen(function () {

      client.once('ready', function () {

        server.close();

        server = new MockServer();

        server.on('request', mock_response)
              .listen(function () {
                client.once('ready', function () {
                  client.take('ip', '191.12.23.32', 1, done);
                });
              });
      }).once('error', function (err) {
        console.log('ignore error', err.code);
      });
    });

  });
});
