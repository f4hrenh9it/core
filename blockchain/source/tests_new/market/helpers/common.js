export async function checkBenchmarks(info, benchmarks) {
    let b = info.map((item) => parseInt(item, 10));
    assert.equal(JSON.stringify(benchmarks), JSON.stringify(b));
}

export async function checkOrderStatus(market, orderId, status) {
    let res = await market.GetOrderParams(orderId, {from: supplier});
    assert.equal(status, res[0]);
}

export async function getDealIdFromOrder(market, consumer, orderId) {
    let orderParams = await market.GetOrderParams(orderId, {from: consumer});
    return orderParams[1].toNumber(10);
}

export async function getDealInfoFromOrder(market, consumer, orderId) {
    let dealId = await getDealIdFromOrder(market, consumer, orderId);
    return await market.GetDealInfo(dealId, {from: consumer});
}