var util = require('util')
var stream = require('readable-stream')

var MockDecoder = function () {
  stream.Transform.call(this)
}

util.inherits(MockDecoder, stream.Transform)

MockDecoder.prototype._transform = function (data, enc, cb) {
  cb()
}

module.exports = MockDecoder;