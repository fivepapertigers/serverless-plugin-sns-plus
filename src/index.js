/* eslint-env node */

const BbPromise = require("bluebird");
const snsPlusSyntax = RegExp(/^snsPlus:/g);
const fs = require("fs");
const path = require("path");




class ServerlessSNSPlusPlugin {

    /** Sets custom Serverless hooks */
    constructor(serverless, options) {
        this.serverless = serverless;
        this.options = options;
        this.provider = this.serverless.getProvider("aws");
        this.currentTopics = [];
        this.topicRefs = [];
        this.hooks = {
            "before:package:initialize": () => BbPromise.bind(this)
                .then(this.convertToSNSEvents),
            "before:deploy:deploy": () => BbPromise.bind(this)
                .then(this.saveCurrentSNSTopics)
                .then(this.createSNSTopics),
            "after:deploy:deploy": () => BbPromise.bind(this)
                .then(this.cleanUpOrphanedTopics)
        };
        this.overrideGetValueFromSource();
        this.validateServerlessVersion()
    }

    /**
     * Converts SNSPlus events to native SNS events
     * @async
     * @return {Promise}
     */
    convertToSNSEvents () {
        this.serverless.cli.log("Converting SNSPlus events to SNS events");
        return this.getAccountId()
            .then(accountId => {
                return accountId;
            })
            .then(accountId =>
                this.allSNSPlusFunctions().forEach(func => {
                    func.events.forEach(event => {
                        if (event.snsPlus) {
                            event.sns = this.formatSNSArn(accountId, event.snsPlus);
                        }
                    });
                })
            );
    }

    /**
     * Cleans up any orphaned topics that are no longer referenced in the
     * Cloudformation config
     * @async
     * @return {Promise}
     */
    cleanUpOrphanedTopics () {
        if (!this.serverless.service.custom || !this.serverless.service.custom.snsPlusClean) {
            return BbPromise.resolve()
        }
        this.serverless.cli.log("Cleaning up removed SNS topics...");
        return BbPromise.all(
            this.currentTopics.map(topicArn => {
                return this.provider.request(
                    "SNS", "getTopicAttributes", {TopicArn: topicArn},
                    this.options.stage, this.getRegion()
                )
                .then(resp => {
                    if (resp && resp.Attributes.SubscriptionsPending === "0" &&
                        resp.Attributes.SubscriptionsConfirmed === "0") {

                        return this.provider.request(
                            "SNS", "deleteTopic", {TopicArn: topicArn},
                            this.options.stage, this.getRegion()
                        );
                    }
                    return null;
                });
            })
        ).then(() => this.serverless.cli.log("SNS topics cleaned."));
    }

    /**
     * Stores the SNS topics that are referenced in the current Cloudformation
     * document (pre-deployment) for use after deployment
     * @async
     * @return {Promise}
     */
    saveCurrentSNSTopics() {
        return this.currentSNSTopics()
            .then(topicArns => {
                this.currentTopics = topicArns;
            });
    }

    /**
     * Creates the SNSPlus topics referenced in the serverless config
     * @async
     * @return {Promise}
     */
    createSNSTopics () {
        this.serverless.cli.log("Creating SNSPlus topics...");
        return BbPromise.all(
            this.allSNSPlusTopics().map(topicName =>
                // Note: if an SNS topic already exists, this call will still
                // return a successful response. No need to pre-determine
                // existence.
                this.provider.request(
                    "SNS", "createTopic", {Name: topicName},
                    this.options.stage, this.getRegion()
                )
            )
        ).then(() => this.serverless.cli.log("SNSPlus topics created."));
    }


    /**
     * Returns a list of all SNSPlus topic names referenced in Serverless
     * config
     * @return {Array<string>}
     */
    allSNSPlusTopics () {
        return this.allSNSPlusFunctions()
            .reduce((events, func) => events.concat(func.events), [])
            .filter(event => event.snsPlus)
            .map(event => event.snsPlus)
            .concat(this.topicRefs);
    }

    /**
     * Returns a list of all functions that subscribe to SNSPlus events
     * @return {Array<Object>} An array of function objects
     */
    allSNSPlusFunctions() {
        return this.allFunctions()
            .filter(func => func.events && func.events.some(event => event.snsPlus));
    }

    /**
     * Returns all defined serverless functions as a list
     * @return {Array<Object>} An array of function objects
     */
    allFunctions() {
        const functions = this.serverless.service.functions || {};
        return Object.keys(functions).map(funcName => functions[funcName]);
    }

    /**
     * Pulls all SNS topics that are referenced in the current Cloudformation
     * document (pre-deployment)
     * @async
     * @return {Promise<Array<string>>}
     */
    currentSNSTopics () {
        return this.provider.request(
            "CloudFormation", "getTemplate",
            {StackName: this.provider.naming.getStackName()},
            this.options.stage,
            this.getRegion())
        // If stack doesn't exist, return empty template
        .catch(() => {
            return {TemplateBody: '{"Resources": {}}'};
        })
        .then(template => JSON.parse(template.TemplateBody).Resources)
        .then(resources => Object.keys(resources)
            .map(name => resources[name])
            .filter(resource =>
                resource.Type === "AWS::SNS::Subscription" &&
                resource.Properties.TopicArn &&
                typeof resource.Properties.TopicArn === "string")
            .map(resource => resource.Properties.TopicArn));
    }

    /**
     * Gets the Account ID of the assumed STS role, necessary for generating
     * ARNs. Caches the ID on the plugin object to avoid redundant roundtrips.
     * @async
     * @return {Promise<string>}
     */
    getAccountId() {
        if (this.accoundId) {
            return BbPromise.resolve(this.accountId);
        }

        return this.provider.request(
            "STS", "getCallerIdentity", {},
            this.options.stage,
            this.getRegion()
        ).then(data => {
            this.accountId = data.Account;
            return this.accountId;
        });
    }

    /**
     * Formats an SNS Arn
     * @param  {string} accountId AWS Account ID that the topic is associated
     *                            with
     * @param  {string} topicName Name of the SNS topic
     * @return {string}
     */
    formatSNSArn(accountId, topicName) {
        return `arn:aws:sns:${this.getRegion()}:${accountId}:${topicName}`;
    }


    /** Wraps the serverless Variable object's `getValueFromSource` method
        with one that can also handle snsPlus variable syntax
    */
    overrideGetValueFromSource() {
        const originalMethod = this.serverless.variables.getValueFromSource;
        const self = this;
        function getValueFromSource(variableString) {
            if (variableString.match(snsPlusSyntax)){
                return self.loadAndReplaceTopicFromVariable(variableString);
            }
            return originalMethod.bind(self.serverless.variables)(variableString);
        }
        this.serverless.variables.getValueFromSource =
            getValueFromSource.bind(this.serverless.variables);
    }

    /**
     * Gets the AWS for this serverless deployment. Defauls to `us-east-1`
     * @return {string} region name
     */
    getRegion() {
        return this.options.region
            || (this.serverless.service.provider && this.serverless.service.provider.region)
            || "us-east-1";
    }

    /**
     * Stores a topic referenced with the `${snsPlus:<topic>}` variable injection
     * and returns the Arn for that SNS topic.
     * @param  {string} variableString `${snsPlus:<topic>}` variable string
     * @return {string} Arn for the SNS topic
     */
    loadAndReplaceTopicFromVariable(variableString) {
        const topicName = variableString.replace(snsPlusSyntax, "");
        return this.getAccountId().then(accountId => {
            this.topicRefs.push(topicName);
            return this.formatSNSArn(accountId, topicName);
        });
    }


    /**
     * Validates that the serverless version is compatible with this plugin
     * @return {string} serverless semver
     */
    validateServerlessVersion() {
        if (this.getServerlessVersion() < "1.13.0") {
            throw new this.serverless.classes.Error(
                "Incompatible serverless version:\n\n" +
                "Serverless version must be at least 1.13.0 to work with " +
                "the SNS Plus plugin."
            );
        }
    }

    /**
     * Gets the current serverless version
     * @return {string} serverless semver
     */
    getServerlessVersion() {
        const slsPath = this.serverless.config.serverlessPath;
        const filePath = path.join(path.dirname(slsPath), "package.json");
        const packageJSON = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return packageJSON.version;
    }
}

module.exports = ServerlessSNSPlusPlugin;
