var url              = require('url');
var _                = require('lodash');
var EventEmitter     = require('events').EventEmitter;
var util             = require('util');
var randomstring     = require('randomstring');
var reconnect        = require('reconnect-net');
var failover         = require('tcp-client-failover');
var through2         = require('through2');

var RequestMessage   = require('./lib/protocol').Request;
var ResponseMessage  = require('./lib/protocol').Response;
var ErrorResponse    = require('./lib/protocol').ErrorResponse;

var lps = require('length-prefixed-stream');
var cb = require('cb');

var defaults = {
  port:    9231,
  host:    'localhost'
};

function LimitdClient (options, done) {

  EventEmitter.call(this);
  
  options = options || { hosts: [] };

  if (_.isArray(options)) {
    options = {
      hosts: options
    };
  }

  if (!options.hosts) {
    options = {
      timeout: options.timeout || undefined,
      hosts: [ options ]
    };
  }

  if (options.hosts.length === 0) {
    options.hosts.push(defaults);
  }

  options.hosts = _.map(options.hosts, (host) => {
    if (typeof host === 'string') {
      host = _.pick(url.parse(host), ['port', 'hostname']);
      host.port = typeof host.port !== 'undefined' ? parseInt(host.port, 10) : undefined;
    }
    return host;
  });

  options.timeout = options.timeout || 1000;

  this._options = options;
  this.pending_requests = {};
  this.connect(done);
}

util.inherits(LimitdClient, EventEmitter);

LimitdClient.prototype.connect = function (done) {
  var options = this._options;

  if (options.hosts.length > 1) {
    this._connectUsingFailover.bind(this)(done);
  } else {
    this._connectUsingReconnect.bind(this)(done);
  }
};

LimitdClient.prototype._connectUsingReconnect = function (done) {
  var self = this;
  var hostConfig = this._options.hosts[0];

  done = done || _.noop;

  self.socket = reconnect(self._onNewStream.bind(self))
  .once('connect', function () {
    setImmediate(function () {
      self.emit('connect');
      done();
    });
  })
  .on('close', function (has_error) {
    self.emit('close', has_error);
  })
  .on('error', function (err) {
    self.emit('error', err);
  })
  .connect(hostConfig.port, hostConfig.address || hostConfig.hostname || hostConfig.host);
};

LimitdClient.prototype._connectUsingFailover = function (done) {
  var self = this;

  done = done || _.noop;

  self.failover = failover.connect(self._options.hosts)
  .on('connected', (stream) => {
    self._onNewStream(stream);
    setImmediate(function () {
      self.emit('connect');
      done();
    });
  })
  .on('disconnected', function () {
    self.emit('close');
  })
  .on('error', function (err) {
    self.emit('error', err);
  });
};

LimitdClient.prototype._onNewStream = function (stream) {
  var self = this;

  stream
  .pipe(lps.decode())
  .pipe(through2.obj(function (chunk, enc, callback) {
    var decoded;
    try {
      decoded = ResponseMessage.decode(chunk);
    } catch(err) {
      return callback(err);
    }
    callback(null, decoded);
  }))
  .on('data', function (response) {
    var response_handler = self.pending_requests[response.request_id];
    if (response_handler) {
      response_handler(response);
    }
  })
  .on('error', function (err) {
    self.emit('error', err);
  });    

  self.stream = stream;

  self.emit('ready');
};

LimitdClient.prototype.disconnect = function () {
  if (this.socket) {
    this.socket.disconnect();
  }

  if (this.failover) {
    this.failover.disconnect();
  }
};

LimitdClient.prototype._request = function (request, type, _callback) {
  var callback = _callback;
  var options = this._options;
  var client = this;

  if (_callback && request.method !== RequestMessage.Method.WAIT) {
    callback = cb(function (err, result) {
      if (err instanceof cb.TimeoutError) {
        return _callback(new Error('request timeout'));
      }
      _callback(err, result);
    }).timeout(options.timeout);
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

  client.pending_requests[request.id] = function (response) {
    delete client.pending_requests[request.id];

    if (response['.limitd.ErrorResponse.response'] &&
        response['.limitd.ErrorResponse.response'].type === ErrorResponse.Type.UNKNOWN_BUCKET_TYPE) {
      return callback(new Error(type + ' is not a valid bucket type'));
    }
    callback(null, response['.limitd.TakeResponse.response'] ||
                   response['.limitd.PutResponse.response']  ||
                   response['.limitd.StatusResponse.response'] );
  };
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

LimitdClient.prototype.ping = function (done) {
  var request = new RequestMessage({
    'id':     randomstring.generate(7),
    'type':   '',
    'key':    '',
    'method': RequestMessage.Method.PING,
  });

  return this._request(request, '', done);
};

module.exports = LimitdClient;