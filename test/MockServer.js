var net  = require('net');
var util = require('util');
var through = require('through');

var EventEmitter = require('events').EventEmitter;

var pbStream = require('pb-stream');
var protocol = require('../lib/protocol');
var decoder  = pbStream.decoder(protocol.Request);
var encoder  = pbStream.encoder(protocol.Response);

function MockServer (options) {
  EventEmitter.call(this);
  var self = this;
  this._options = options || {};
  this._sockets = [];

  this._server = net.createServer(function (socket) {
    self._sockets.push(socket);

    socket.pipe(decoder)
          .pipe(through(function (request) {
            var stream = this;

            var replier = function (response) {
              stream.queue(response);
            };

            self.emit('request', request, replier);
          }))
          .pipe(encoder)
          .pipe(socket);

  });
}

util.inherits(MockServer, EventEmitter);

MockServer.prototype.listen = function (done) {
  this._server.listen(this._options.port || 9231, done);
};

MockServer.prototype.close = function (done) {
  this._sockets.forEach(function (socket) {
    try {
      socket.destroy();
    } catch(err) {}
  });
  this._server.close(done);
};


module.exports = MockServer;