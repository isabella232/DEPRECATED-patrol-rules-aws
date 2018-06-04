const AWS = require('aws-sdk');
const d3 = require('d3-queue');
const message = require('@mapbox/lambda-cfn').message;
const splitOnComma = require('@mapbox/lambda-cfn').splitOnComma;

module.exports.fn = (event, context, callback) => {
  if (event.detail.errorCode) return callback(null, event.detail.errorMessage);
  let iam = new AWS.IAM();
  let q = d3.queue(1);
  let principal;
  let fullPrincipal;
  let arnRegex;

  if (!process.env.principalRegex.toLowerCase() == 'none' || !process.env.principalRegex == '') {
    try {
      arnRegex = new RegExp(process.env.principalRegex, 'i');
    } catch (e) {
      console.log(`ERROR: Invalid regex ${process.env.principalRegex}, ${e}`);
      return callback(e);
    }

    if (arnRegex.test(event.detail.userIdentity.sessionIssuer.arn)) {
      principal = event.detail.userIdentity.sessionIssuer.arn;

    } else {
      console.log(`INFO: skipping principal ${event.detail.userIdentity.sessionIssuer.arn}`);
      return callback();
    }
  } else {
    principal = event.detail.userIdentity.sessionIssuer.arn;
  }
  fullPrincipal = event.detail.userIdentity.arn;

  let document = event.detail.requestParameters.policyDocument;
  let parsed = JSON.parse(document);

  let simulate = function(params, cb) {
    iam.simulatePrincipalPolicy(params, (err, data) => {
      cb(err, data);
    });
  };

  parsed.Statement.forEach((policy) => {
    policyProcessor(policy);
  });

  function policyProcessor(policy) {
    let actions = [];
    let resources = [];
    if (policy.Effect === 'Allow' && policy.Action) {
      actions = typeof policy.Action === 'string' ? [policy.Action] : policy.Action;
    }
    resources = typeof policy.Resource === 'string' ? [policy.Resource] : policy.Resource;

    let params = {
      PolicySourceArn: principal,
      ActionNames: actions,
      ResourceNames: resources
    };
    q.defer(simulate, params);
  }

  q.awaitAll(function(err, data) {
    if (err) return callback(err);
    let matches = [];
    let truncated = false;
    data.forEach(function(response) {
      // Warn on truncation.  Build paging support if this is hit.
      if (response.IsTruncated) truncated = true;
      response.EvaluationResults.forEach((result) => {
        if (result.EvalDecision === 'denied') {
          matches.push(result.EvalResourceName);
        }
      });
    });

    // Report
    let q = d3.queue(1);
    if (truncated) {
      q.defer(message, {
        subject: 'Principal policy rule results truncated',
        summary: 'Principal policy rule results were truncated. Paging ' +
          'is not currently supported.'
      });
    }

    let iamResource = parsed.requestParameters.policyArn ? parsed.requestParameters.policy : parsed.requestParameters.roleName;

    if (matches.length) {
      q.defer(message, {
        subject: `Principcal ${fullPrincipal} allowed access to restricted resource via ${iamResource}`,
        summary: `Principcal ${fullPrincipal} allowed access to restricted resource via ${iamResource}:  ${matches.join(', ')}`,
        event: event
      });
    }

    q.awaitAll((err, ret) => {
      callback(err, ret);
    });
  });
};
