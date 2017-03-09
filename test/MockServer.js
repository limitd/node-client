const net          = require('net');
const util         = require('util');
const lps          = require('length-prefixed-stream');
const Transform    = require('stream').Transform;
const EventEmitter = require('events').EventEmitter;
const protocol     = require('../lib/protocol');

function stream_map (mapper) {
  return Transform({
    objectMode: true,
    transform(chunk, enc, callback) {
      try {
        this.push(mapper(chunk));
      } catch(err) {
        return callback(err);
      }
      callback();
    }
  });
}

function MockServer (options) {
  EventEmitter.call(this);
  var self = this;
  this._options = options || {};
  this._sockets = [];

  // var decoder  = pbStream.decoder(protocol.Request);
  // var encoder  = pbStream.encoder(protocol.Response);

  this._server = net.createServer(function (socket) {
    self._sockets.push(socket);

    socket
    .pipe(lps.decode())
    .pipe(stream_map(chunk => protocol.Request.decode(chunk)))
    .pipe(Transform({
      objectMode: true,
      transform(request, enc, callback) {
        var stream = this;

        var replier = function (response) {
          stream.push(response);
        };

        self.emit('request', request, replier);
        callback();
      }
    }))
    .pipe(stream_map(response => protocol.Response.encodeDelimited(response).finish()))
    .pipe(socket);
  });
}

util.inherits(MockServer, EventEmitter);

MockServer.prototype.listen = function (done) {
  var listener = this._server.listen(this._options.port || 9231, () => {
    this._server.port = listener.address().port;
    done();
  });
};

MockServer.prototype.close = function (done) {
  this._server.close(() => {
    if (done) {done();}
  });

  this._sockets.forEach((socket) => {
    try {
      socket.destroy();
    } catch(err) {}
  });
};


module.exports = MockServer;
