var url              = require('url');
var _                = require('lodash');
var EventEmitter     = require('events').EventEmitter;
var util             = require('util');
var randomstring     = require('randomstring');
var reconnect        = require('reconnect-net');

var RequestMessage   = require('./lib/protocol').Request;
var ResponseMessage  = require('./lib/protocol').Response;
var ErrorResponse    = require('./lib/protocol').ErrorResponse;

var decoder          = require('pb-stream').decoder;
var encoder          = require('pb-stream').encoder;
var cb               = require('cb');

var DEFAULT_PORT = 9231;
var DEFAULT_HOST = 'localhost';

function LimitdClient (options) {
  options = options || {};
  EventEmitter.call(this);
  if (typeof options === 'string') {
    options = _.pick(url.parse(options), ['port', 'hostname']);
    options.port = parseInt(options.port || DEFAULT_PORT, 10);
  } else {
    options.port = options.port || DEFAULT_PORT;
    options.host = options.host || DEFAULT_HOST;
  }
  this._options = options;
  this.connect();
}

util.inherits(LimitdClient, EventEmitter);

LimitdClient.prototype.connect = function (done) {
  var options = this._options;
  var client = this;

  this.socket = reconnect(function (stream) {
    stream.pipe(decoder(ResponseMessage)).on('data', function (response) {
      client.emit('response', response);
      client.emit('response_' + response.request_id, response);
    });

    client.stream = stream;

    client.writer = encoder(RequestMessage);
    client.writer.pipe(client.stream);

    client.emit('ready');

    stream.on('error', function (err) {
      client.emit('error', err);
    });

  }).once('connect', function () {
    process.nextTick(function () {
      client.emit('connect');

      if (done) {
        done();
      }
    });
  }).on('close', function (has_error) {
    client.emit('close', has_error);
  }).on('error', function (err) {
    client.emit('error', err);
  }).connect(options.port, options.address || options.hostname || options.host);
};

LimitdClient.prototype.disconnect = function () {
  this.socket.disconnect();
};

LimitdClient.prototype._request = function (request, type, _callback) {
  var callback = _callback;

  if (_callback && request.method !== RequestMessage.Method.WAIT) {
    callback = cb(function (err, result) {
      if (err instanceof cb.TimeoutError) {
        return _callback(new Error('request timeout'));
      }
      _callback(err, result);
    }).timeout(1000);
  }

  if (!this.stream || !this.stream.writable) {
    var err = new Error('The socket is closed.');
    if (callback) {
      return process.nextTick(function () {
        callback(err);
      });
    } else {
      throw err;
    }
  }

  this.stream.write(request.encodeDelimited().toBuffer());

  if (!callback) return;

  this.once('response_' + request.id, function (response) {
    if (response.type === ResponseMessage.Type.ERROR &&
        response['.limitd.ErrorResponse.response'].type === ErrorResponse.Type.UNKNOWN_BUCKET_TYPE) {
      return callback(new Error(type + ' is not a valid bucket type'));
    }
    callback(null, response['.limitd.TakeResponse.response'] || response['.limitd.PutResponse.response'] || response['.limitd.StatusResponse.response']);
  });
};

LimitdClient.prototype._takeOrWait = function (method, type, key, count, done) {
  if (typeof count === 'undefined' && typeof done === 'undefined') {
    done = null;
    count = 1;
  } else if (typeof count === 'function') {
    done = count;
    count = 1;
  }

  var request = new RequestMessage({
    'id':     randomstring.generate(7),
    'type':   type,
    'key':    key,
    'method': RequestMessage.Method[method],
  });

  if (count === 'all') {
    request.set('all', true);
  } else {
    request.set('count', count);
  }

  return this._request(request, type, done);
};

LimitdClient.prototype.take = function (type, key, count, done) {
  return this._takeOrWait('TAKE', type, key, count, done);
};

LimitdClient.prototype.wait = function (type, key, count, done) {
  return this._takeOrWait('WAIT', type, key, count, done);
};

LimitdClient.prototype.reset =
LimitdClient.prototype.put = function (type, key, count, done) {
  if (typeof count === 'undefined' && typeof done === 'undefined') {
    done = null;
    count = 'all';
  } else if (typeof count === 'function') {
    done = count;
    count = 'all';
  }

  var request = new RequestMessage({
    'id':     randomstring.generate(7),
    'type':   type,
    'key':    key,
    'method': RequestMessage.Method.PUT,
  });

  if (count === 'all') {
    request.set('all', true);
  } else {
    request.set('count', count);
  }

  return this._request(request, type, done);
};

LimitdClient.prototype.status = function (type, key, done) {
  var request = new RequestMessage({
    'id':     randomstring.generate(7),
    'type':   type,
    'key':    key,
    'method': RequestMessage.Method.STATUS,
  });

  return this._request(request, type, done);
};

module.exports = LimitdClient;