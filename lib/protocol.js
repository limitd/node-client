require('protobufjs/src/parse').defaults.keepCase = true;

const ProtoBuf  = require('protobufjs');
const path      = require('path');
const protoPath = path.join(__dirname, '/../protocol/Index.proto');
const builder   = ProtoBuf.loadSync(protoPath);

module.exports = builder.lookup('limitd');
