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
  this._server = net.createServer(function (socket) {

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
  this._server.close(done);
};


module.exports = MockServer;