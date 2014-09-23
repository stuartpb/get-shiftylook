#!/usr/bin/env node
'use strict';

var request = require('request');
var cheerio = require('cheerio');
var Bottleneck = require('bottleneck');
var mkdirp = require('mkdirp');
var url = require('url');
var fs = require('fs');
var path = require('path');

var hostq = new Bottleneck(1, 10000);

var scope = 'http://www.shiftylook.com/comics/';

var outdir = __dirname + '/results';

var requested  = new Object(null);
var errors = new Object(null);
var retryLimit = 20;

function startsWith(s, prefix) {
  return s.slice(0,prefix.length) == prefix;
}

function savedFilename(fqurl) {
  return path.join(outdir, fqurl.replace(/^https?:\/\//,''));
}

function savedPagename(fqurl) {
  return path.join(savedFilename(fqurl), 'index.html');
}

function saveResponseBody(path) {
  return function (err, res, body) {
    fs.writeFileSync(path, body);
  };
}

function loudRequest() {
  console.log('Requesting '+ arguments[0]);
  request.apply(this, arguments);
}

function retryingRequest(fqurl, cb) {
  function retry(err) {
    errors[fqurl] = errors[fqurl] || 0;
    if (++errors[fqurl] < retryLimit) {
      console.error('Received error for ' + fqurl + ', retrying: ', err);
      retryingRequest(fqurl,cb);
    } else {
      console.error('Error limit reached for ' + fqurl + ': ', err);
    }
  }
  function retryingCb(err, res, body) {
    if (err) {
      if (err.code == 'ETIMEDOUT' || err.code == 'ECONNRESET') {
        retry(err);
      } else {
        console.error('Unrecoverable error for ' + fqurl + ': ', err);
      }
    } else if (res.statusCode >= 400) {
      if (res.statusCode == 504) { // gateway timeout
        retry('HTTP 504');
      } else {
        console.error('Unrecoverable error for ' + fqurl +
          ': HTTP ' + res.statusCode);
      }
    } else {
      console.log('Received '+fqurl);
      return cb(err, res, body);
    }
  }
  var parsed = url.parse(fqurl);
  if (/amazonaws\.com$/.test(parsed.hostname)) {
    loudRequest(fqurl, retryingCb);
  } else if (/shiftylook\.com$/.test(parsed.hostname)) {
    hostq.submit(loudRequest, fqurl, retryingCb);
  }
}

function requestAsset(fqurl) {
  var path = savedFilename(fqurl);

  // don't re-request assets
  if (requested[path]) return;

  requested[path] = true;

  // existing assets have already been requested
  if (fs.existsSync(path)) return;

  return retryingRequest(fqurl, saveResponseBody(path));
}

function parsePage(body) {
  var $ = cheerio.load(body);
  function requestAttr(attr, requestor) {
    return function (i, el) {
      var fqurl = $(el).attr(attr);
      if (fqurl) {
        requestor(fqurl);
      }
    };
  }
  // TODO: request assets in CSS
  $('head link').each(requestAttr('href', requestAsset));
  $('script, body img').each(requestAttr('src', requestAsset));
  $('body a').each(requestAttr('href', requestPage));
}

function receivePage(path) {
  return function (err, res, body) {
    parsePage(body);
    // TODO: path should really be decided more around here -
    // it's possible a page could hyperlink to non-HTML content
    // Could also do a thing with requesting CSS using this function
    mkdirp(path.replace(/\/[^\/]*$/,'/'));
    fs.writeFileSync(path, body);
  };
}

function requestPage(fqurl) {
  // only request pages within scope
  if (!startsWith(fqurl, scope)) return;

  var path = savedPagename(fqurl);

  // don't re-request assets
  if (requested[path]) return;

  requested[path] = true;

  // existing pages have already been requested
  if (fs.existsSync(path)) {
    // TODO: stat the savedFilename path, and only do this for savedPagename
    // if savedFilename is a directory and savedPagename exists
    return parsePage(fs.readFileSync(path));
  } else {
    return retryingRequest(fqurl, receivePage(path));
  }
}

requestPage(scope);
