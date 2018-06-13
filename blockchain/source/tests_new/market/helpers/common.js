export async function checkBenchmarks(info, benchmarks) {
    let b = info.map((item) => parseInt(item, 10));
    assert.equal(JSON.stringify(benchmarks), JSON.stringify(b));
}

export async function checkOrderStatus(market, orderId, status) {
    let res = await market.GetOrderParams(orderId, {from: supplier});
    assert.equal(status, res[0]);
}

export async function getDealInfo(market, orderId) {
    let orderParams = await market.GetOrderParams(orderId, {from: consumer});
    let dealId = orderParams[1];
    return await market.GetDealInfo(dealId, {from: consumer});
}