var LimitdClient = require('../');
var MockServer = require('./MockServer');
var protocol = require('../lib/protocol');

var Response = protocol.Response;
var TakeResponse = protocol.TakeResponse;


function mock_response (request, reply) {
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
      });
    });

  });
});