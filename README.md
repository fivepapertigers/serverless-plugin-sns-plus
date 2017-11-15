# Serverless Plugin SNS Plus

A Serverless framework plugin to improve some of the pain points around SNS topics.

## What is it?

The SNS Plus plugin manages SNS topics outside of the Serverless service's default Cloudformation stack. Topics are created on-demand, whenever they are referenced in `serverless.yml`.

## Usage

### Function Event

Subscribe a topic to an SNS Plus event, using similar syntax to the built-in `sns` event.
```yaml
# serverless.yml
functions:
  myFunctionName:
    handler: someModule.handler
    events:
      - snsPlus: MyTopicName
```

This will do one of two things:
    1. Create a topic if it doesn't already exist, then subscribe the Lambda function to it.
    2. Subscribe to a topic that already exists.

Note: the topic is assumed to be in the same account/region where your service will be deployed. This may change something in the future.


### Variable Syntax

```yaml
# serverless.yml
functions:
  myFunctionName:
    handler: someModule.handler
    environment:
      MY_TOPIC: ${snsPlus:MyTopicName}

The `snsPlus` variable syntax accepts an SNS topic and does two things:
    1. Replaces the topic name with the full Arn of the SNS topic
    2. Creates the SNS topic before deployment if it does not already exist.

This is helpful if a function needs to publish as a part of its work, for example.
