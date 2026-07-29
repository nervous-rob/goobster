/**
 * The Jimbucks Exchange - margin, shorts, options, resting orders, and event
 * contracts on top of the point economy.
 *
 * Layering: pure math (optionsMath, marginMath) -> market data (optionsMarket)
 * -> position services (accountService, shortService, optionsService,
 * orderService, predictionService) -> the RiskEngine tick -> auditService,
 * which only reads. Every wallet movement still goes through
 * economyService.adjust(); everything the engine does lands in
 * `exchange_events`.
 */
module.exports = {
    ExchangeError: require('./errors').ExchangeError,
    exchangeConfig: require('./exchangeConfig'),
    exchangeEvents: require('./exchangeEvents'),
    optionsMath: require('./optionsMath'),
    marginMath: require('./marginMath'),
    optionsMarket: require('./optionsMarket'),
    accountService: require('./accountService'),
    shortService: require('./shortService'),
    optionsService: require('./optionsService'),
    spreadMath: require('./spreadMath'),
    spreadService: require('./spreadService'),
    perpsService: require('./perpsService'),
    orderService: require('./orderService'),
    predictionService: require('./predictionService'),
    groupPlayService: require('./groupPlayService'),
    wheelService: require('./wheelService'),
    corporateActionsService: require('./corporateActionsService'),
    auditService: require('./auditService'),
    RiskEngine: require('./riskEngine')
};
