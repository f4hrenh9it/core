const assert = require('chai').assert;

const eventInLogs = async (logs, eventName) => {
    const event = logs.find(e => e.event === eventName);
    assert.exists(event, `event ${eventName} wasn't emitted`);
    return event.args
};

const eventInTransaction = async (tx, eventName) => {
    const { logs } = await tx;
    return eventInLogs(logs, eventName);
};

module.exports = {
    eventInLogs,
    eventInTransaction,
};
