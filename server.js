const process = require('process');
const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');
const redis = require('redis');

const HOSTS = process.env.HOSTS.split(',');
const REDIS = redis.createClient(process.env.REDIS_URL || 'redis://127.0.0.1:6379/0');
const ONEDAY = 60 * 60 * 24;
const LIFETIME = ONEDAY * parseInt(process.env.LIFETIME || '14', 10);

function httpRequest(host, path, originalHeaders, success, error) {
  const uri = url.parse(host);
  const port = uri.protocol === 'https:' ? 443 : 80;
  const headers = {
    accept: '*/*', 'accept-encoding': 'gzip',
  };
  if (originalHeaders.origin) {
    headers.origin = originalHeaders.origin;
  }

  const options = {
    hostname: uri.hostname,
    port, headers, path,
    timeout: 10 * 1000,
  };

  const request = (port === 80 ? http : https).request(options, (response) => {
    console.log('response', response.statusCode, options.hostname, options.path);
    if (response.statusCode === 200) {
      success({ host, response });
    } else {
      response.destroy();
      error(new Error('Not OK'));
    }
  });
  request.on('error', error);
  request.end();
}

function copyResponseHeaders(src, dest) {
  const srcHeaders = src.headers;
  ['Content-Type', 'Cache-Control', 'Date', 'ETag', 'Last-Modified',
   'Access-Control-Allow-Origin', 'Access-Control-Allow-Methods',
   'Access-Control-Expose-Headers', 'Access-Control-Max-Age',
   'Access-Control-Allow-Credentials', 'Access-Control-Allow-Headers'].forEach(name => {
    const key = name.toLowerCase();
    const value = srcHeaders[key];
    if (value && value.length > 0) {
      dest.setHeader(name, value);
    }
  });
}

function streamGzip(src, req, dest) {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  const contentEncoding = src.headers['content-encoding'] || '';

  if (acceptEncoding.includes('gzip')) {
    dest.setHeader('Content-Encoding', 'gzip');
    if (!contentEncoding.includes('gzip')) {
      return src.pipe(zlib.createGzip());
    }
  } else {
    if (contentEncoding.includes('gzip')) {
      return src.pipe(zlib.createGunzip());
    }
  }

  return src;
}

// req == http.IncomingMessage
// res == http.ServerResponse
http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.statusCode = 400;
    res.end();
    return;
  }

  if (process.env.AUTHORIZATION && process.env.AUTHORIZATION.length > 0) {
    if (req.headers.authorization !== process.env.AUTHORIZATION) {
      res.statusCode = 401;
      res.end();
      return;
    }
  }

  console.log('request', req.url);

  REDIS.get(req.url, (err, cachedHost) => {
    let hosts = null;

    if (cachedHost) {
      hosts = [cachedHost];
    } else {
      hosts = [...HOSTS];
    }

    let errors = null;
    const success = new Promise((success) => {
      errors = hosts.map((host) => (
        new Promise((error) => (
          httpRequest(host, req.url, req.headers, success, error)
        ))
      ));
    });

    Promise.race([success, Promise.all(errors)]).then((value) => {
      if (Array.isArray(value)) {
        throw new Error('Not Found');
      }

      const { host, response } = value;

      REDIS.set([req.url, host, 'EX', `${LIFETIME}`]);

      res.statusCode = response.statusCode;
      res.setHeader('Connection', 'close');
      copyResponseHeaders(response, res);
      streamGzip(response, req, res).pipe(res);
    }).catch((err) => {
      console.log('err', err);
      res.statusCode = 404;
      res.end();
    });
  });
}).listen(process.env.PORT);
