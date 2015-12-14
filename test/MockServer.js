var net  = require('net');
var util = require('util');
var lps = require('length-prefixed-stream');
var through2 = require('through2');

var EventEmitter = require('events').EventEmitter;

var protocol = require('../lib/protocol');

function MockServer (options) {
  EventEmitter.call(this);
  var self = this;
  this._options = options || {};
  this._sockets = [];

  // var decoder  = pbStream.decoder(protocol.Request);
  // var encoder  = pbStream.encoder(protocol.Response);

  this._server = net.createServer(function (socket) {
    self._sockets.push(socket);

    socket.pipe(lps.decode())
          .pipe(through2.obj(function (chunk, enc, callback) {
            var decoded;
            try {
              decoded = protocol.Request.decode(chunk);
            } catch(err) {
              console.log(err);
              return callback(err);
            }

            callback(null, decoded);
          }))
          .pipe(through2.obj(function (request, enc, callback) {
            var stream = this;

            var replier = function (response) {
              stream.push(response);
            };

            self.emit('request', request, replier);
            callback();
          }))
          .pipe(through2.obj(function (response, enc, callback) {
            var encoded;

            try {
              encoded = response.encodeDelimited().toBuffer();
            } catch(err) {
              return callback(err);
            }

            callback(null, encoded);
          }))
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