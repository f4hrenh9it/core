import {
    benchmarkQuantity,
    billTolerance,
    BlackListPerson,
    DealInfo,
    DealParams,
    DealStatus,
    defaultBenchmarks,
    IdentityLevel,
    netflagsQuantity,
    oraclePrice,
    orderInfo,
    OrderParams,
    OrderStatus,
    OrderType,
    secInDay,
    secInHour,
    testDuration,
    testPrice,
} from "./helpers/constants";
import increaseTime from '../helpers/increaseTime';
import assertRevert from '../helpers/assertRevert';
import {eventInTransaction, allEventsInTransaction} from '../helpers/expectEvent';
import {Ask} from './helpers/ask'
import {Bid} from './helpers/bid'
import {checkBenchmarks, checkOrderStatus, getDealIdFromOrder, getDealInfoFromOrder} from "./helpers/common";

const SNMD = artifacts.require('./SNMD.sol');
const Market = artifacts.require('./Market.sol');
const OracleUSD = artifacts.require('./OracleUSD.sol');
const Blacklist = artifacts.require('./Blacklist.sol');
const ProfileRegistry = artifacts.require('./ProfileRegistry.sol');

contract('Market', async (accounts) => {
    let market;
    let token;
    let oracle;
    let blacklist;
    let profileRegistry;
    let supplier = accounts[1];
    let consumer = accounts[2];
    let master = accounts[3];
    let specialConsumer = accounts[4];
    let specialConsumer2 = accounts[5];
    let blacklistedSupplier = accounts[6];

    before(async () => {
        token = await SNMD.new();
        oracle = await OracleUSD.new();
        await oracle.setCurrentPrice(oraclePrice);
        blacklist = await Blacklist.new();
        profileRegistry = await ProfileRegistry.new();
        market = await Market.new(
            token.address,
            blacklist.address,
            oracle.address,
            profileRegistry.address,
            benchmarkQuantity,
            netflagsQuantity,
        );
        await token.AddMarket(market.address);
        await blacklist.SetMarketAddress(market.address);

        await token.transfer(consumer, oraclePrice / 1e7, {from: accounts[0]});
        await token.transfer(supplier, oraclePrice / 1e7, {from: accounts[0]});
        await token.transfer(specialConsumer, 3600, {from: accounts[0]});
        await token.transfer(specialConsumer2, 3605, {from: accounts[0]});
    });

    it('check balances', async () => {
        await token.balanceOf.call(supplier);
        await token.balanceOf.call(consumer);
    });

    describe('Orders: ', async () => {
        it('CreateOrder forward ask', async () => {
            // TODO: test above normal deal
            let oid = await Ask({market, supplier});

            let info = await market.GetOrderInfo(oid, {from: supplier});
            assert.equal(OrderType.ASK, info[orderInfo.type]);
            assert.equal(supplier, info[orderInfo.author]);
            assert.equal('0x0000000000000000000000000000000000000000', info[orderInfo.counterparty]);
            assert.equal(testDuration, info[orderInfo.duration]);
            assert.equal(testPrice, info[orderInfo.price]);
            assert.equal(JSON.stringify([false, false, false]), JSON.stringify(info[orderInfo.netflags]));
            assert.equal(IdentityLevel.ANONIMOUS, info[orderInfo.identityLvl]);
            assert.equal(0x0, info[orderInfo.blacklist]);
            assert.equal(0x0000000000000000000000000000000000000000000000000000000000000000,
                info[orderInfo.tag]);
            let b = info[orderInfo.benchmarks].map((item) => parseInt(item, 10));
            assert.equal(JSON.stringify(defaultBenchmarks), JSON.stringify(b));
            assert.equal(0, info[orderInfo.frozenSum]);

            let balance = await token.balanceOf(market.address);
            assert.equal(0, balance)
        });

        it('CreateOrder forward bid', async () => {
            let balanceBefore = await token.balanceOf(consumer);
            let oid = await Bid({market, consumer});
            let info = await market.GetOrderInfo(oid, {from: consumer});
            assert.equal(OrderType.BID, info[orderInfo.type]);
            assert.equal(consumer, info[orderInfo.author]);
            assert.equal('0x0000000000000000000000000000000000000000', info[orderInfo.counterparty]);
            assert.equal(testDuration, info[orderInfo.duration]);
            assert.equal(testPrice, info[orderInfo.price]);
            assert.equal(JSON.stringify([false, false, false]), JSON.stringify(info[orderInfo.netflags]));
            assert.equal(IdentityLevel.ANONIMOUS, info[orderInfo.identityLvl]);
            assert.equal(0x0, info[orderInfo.blacklist]);
            assert.equal(0x0000000000000000000000000000000000000000000000000000000000000000,
                info[orderInfo.tag]);
            let b = info[9].map((item) => parseInt(item, 10));
            assert.equal(JSON.stringify(defaultBenchmarks), JSON.stringify(b));
            assert.equal(secInDay * oraclePrice * testPrice / 1e18, info[orderInfo.frozenSum]);

            let balanceAfter = await token.balanceOf(consumer);
            assert.equal(balanceBefore.toNumber() - secInDay * oraclePrice * testPrice / 1e18,
                balanceAfter.toNumber());
            let balance = await token.balanceOf(market.address);
            assert.equal(secInDay * oraclePrice * testPrice / 1e18, balance);
            // TODO: test above normal deal
            // TODO: get balance and check block for 1 day

            // TODO: test above normal deal - VAR#2 - for deal-duration
            // TODO: get balance and check block for deal duration

            // TODO: test above spot deal
            // TODO: get balance and check block for 1 hour
        });

        it('CreateOrder spot ask', async () => {
            let oid = await Ask({market, supplier, duration: 0});
            let info = await market.GetOrderInfo(oid, {from: supplier});
            assert.equal(0, info[orderInfo.duration])
        });

        it('CreateOrder spot bid', async () => {
            // TODO: test above normal deal
            let balanceBefore = await token.balanceOf(consumer);
            await Bid({market, consumer, duration: 0});
            let balanceAfter = await token.balanceOf(consumer);
            assert.equal(balanceBefore.toNumber() - secInHour * oraclePrice * testPrice / 1e18,
                balanceAfter.toNumber());
        });


        it('CancelOrder: cancel ask order', async () => {
            let balanceBefore = await token.balanceOf(supplier);

            let oid = await Ask({market, supplier});
            await market.CancelOrder(oid, {from: supplier});

            let balanceAfter = await token.balanceOf(supplier);
            assert.equal(balanceBefore.toNumber(), balanceAfter.toNumber());

            let res = await market.GetOrderParams(oid, {from: supplier});
            assert.equal(OrderStatus.INACTIVE, res[OrderParams.status]);
            assert.equal(0, res[OrderParams.dealId]);
            // TODO: verify order = inactive
            // TODO: verify token not(!) transfered
            // TODO: verify catch the event - not properly

            // TODO: verify order = inactive
            // TODO: verify token transfered
            // TODO: verify catch the event - not properly
        });

        it('CancelOrder: cancel bid order', async () => {
            let balanceBefore = await token.balanceOf(consumer);

            let oid = await Bid({market, consumer});
            await market.CancelOrder(oid, {from: consumer});

            let balanceAfter = await token.balanceOf(consumer);
            assert.equal(balanceBefore.toNumber(), balanceAfter.toNumber());

            let res = await market.GetOrderParams(oid, {from: consumer});
            assert.equal(OrderStatus.INACTIVE, res[OrderParams.status]);
            assert.equal(0, res[OrderParams.dealId]);
        });

        it('CancelOrder: cancelling inactive order', async () => {
            let oid = await Bid({market, consumer});
            await market.CancelOrder(oid, {from: consumer});
            await assertRevert(market.CancelOrder(oid, {from: consumer}));
        });

        it('CancelOrder: cancelling not by author', async () => {
            let oid = await Bid({market, consumer});
            await assertRevert(market.CancelOrder(oid, {from: supplier}));
        });
    });

    describe('Deals:', async () => {
        it('OpenDeal forward', async () => {
            let askId = await Ask({market, supplier});
            let bidId = await Bid({market, consumer});
            await market.OpenDeal(askId, bidId, {from: consumer});

            let askParams = await market.GetOrderParams(askId, {from: supplier});
            let bidParams = await market.GetOrderParams(bidId, {from: consumer});
            assert.equal(OrderStatus.INACTIVE, askParams[OrderParams.status]);
            assert.equal(OrderStatus.INACTIVE, bidParams[OrderParams.status]);

            let dealId = bidParams[1];
            let dealInfo = await market.GetDealInfo(dealId, {from: consumer});
            assert.equal(supplier, dealInfo[DealInfo.supplier]);
            assert.equal(consumer, dealInfo[DealInfo.consumer]);
            assert.equal(supplier, dealInfo[DealInfo.master]);
        });

        it('OpenDeal: spot', async () => {
            let askId = await Ask({market, supplier, duration: 0});
            let bidId = await Bid({market, consumer, duration: 0});
            await market.OpenDeal(askId, bidId, {from: consumer});

            let askParams = await market.GetOrderParams(askId, {from: supplier});
            let bidParams = await market.GetOrderParams(bidId, {from: consumer});
            assert.equal(OrderStatus.INACTIVE, askParams[OrderParams.status]);
            assert.equal(OrderStatus.INACTIVE, bidParams[OrderParams.status]);

            let dealId = bidParams[1];
            let dealInfo = await market.GetDealInfo(dealId, {from: consumer});
            assert.equal(supplier, dealInfo[DealInfo.supplier]);
            assert.equal(consumer, dealInfo[DealInfo.consumer]);
            assert.equal(supplier, dealInfo[DealInfo.master]);
        });

        it('OpenDeal:closing after ending', async () => {
            let duration = 1;
            let askId = await Ask({market, supplier, duration: duration, price: 1});
            let bidId = await Bid({market, consumer, duration: duration, price: 1});
            await market.OpenDeal(askId, bidId, {from: consumer});
            await increaseTime(duration + 1);

            let bidParams = await market.GetOrderParams(bidId, {from: consumer});
            let dealId = bidParams[1];

            await market.CloseDeal(dealId, BlackListPerson.NOBODY, {from: consumer});
            let dealParams = await market.GetDealParams(dealId, {from: consumer});
            assert.equal(DealStatus.CLOSED, dealParams[DealParams.status])
        });
    });


    describe('Bills:', () => {
        let presetFwdDealId;
        let presetFwdDealInfo;
        let presetFwdDealParams;
        let presetSpotDealId;
        let presetSpotDealInfo;
        let presetSpotDealParams;

        before(async () => {
            let askId = await Ask({market, supplier});
            let bidId = await Bid({market, consumer});
            await market.OpenDeal(askId, bidId, {from: consumer});
            let bidParams = await market.GetOrderParams(bidId, {from: consumer});
            presetFwdDealId = bidParams[OrderParams.dealId];
            presetFwdDealInfo = await market.GetDealInfo(presetFwdDealId, {from: consumer});
            presetFwdDealParams = await market.GetDealParams(presetFwdDealId, {from: consumer});

            let saskId = await Ask({market, supplier, duration: 0});
            let sbidId = await Bid({market, consumer, duration: 0});
            await market.OpenDeal(saskId, sbidId, {from: consumer});
            let sbidParams = await market.GetOrderParams(sbidId, {from: consumer});
            presetSpotDealId = sbidParams[OrderParams.dealId];
            presetSpotDealInfo = await market.GetDealInfo(presetSpotDealId, {from: consumer});
            presetSpotDealParams = await market.GetDealParams(presetSpotDealId, {from: consumer});

            await increaseTime(secInHour / 2);
        });

        it('forward deal: balance is freezed for sum of one day', async () => {
            let rate = (await oracle.getCurrentPrice()).toNumber();
            let shouldBlocked = testPrice * secInDay * rate / 1e18;
            // we do not cast getters as as struct
            let nowBlocked = presetFwdDealParams[DealParams.blockedBalance].toNumber();
            assert.equal(shouldBlocked, nowBlocked);
        });

        it('billing spot deal', async () => {
            let consumerBalanceBefore = await token.balanceOf(consumer);
            let supplierBalanceBefore = await token.balanceOf(supplier);

            let lastBillTSBefore = presetSpotDealParams[DealParams.lastBillTs];

            let tx = await market.Bill(presetSpotDealId, {from: supplier});

            let consumerBalanceAfter = await token.balanceOf(consumer);
            let supplierBalanceAfter = await token.balanceOf(supplier);

            let dealParamsAfter = await market.GetDealParams(presetSpotDealId);

            let lastBillTSAfter = dealParamsAfter[DealParams.lastBillTs];

            let billPeriod = lastBillTSAfter.toNumber() - lastBillTSBefore.toNumber();

            // check event
            let event = await eventInTransaction(tx, 'Billed');
            assert.equal(event.paidAmount.toNumber(), billPeriod * oraclePrice * testPrice / 1e18);

            // console.log(`consumer after: ${consumerBalanceAfter.toFixed()}`);
            // console.log(`consumer before: ${consumerBalanceBefore.toFixed()}`);
            // console.log(`difference: ${consumerBalanceBefore.toNumber() - consumerBalanceAfter.toNumber()}`);
            assert.equal(consumerBalanceAfter.toNumber(),
                consumerBalanceBefore.toNumber() - event.paidAmount.toNumber());

            // console.log(`supplier after: ${supplierBalanceAfter.toFixed()}`);
            // console.log(`supplier before: ${supplierBalanceBefore.toFixed()}`);
            // console.log(`difference: ${supplierBalanceAfter.toNumber() - supplierBalanceBefore.toNumber()}`);
            assert.equal(supplierBalanceAfter.toNumber(),
                supplierBalanceBefore.toNumber() + event.paidAmount.toNumber());
        });

        it('billing forward deal', async function () {
            let deal = await market.GetDealParams(presetFwdDealId);
            let consumerBalanceBefore = await token.balanceOf(consumer);
            let supplierBalanceBefore = await token.balanceOf(supplier);

            let lastBillTSBefore = deal[DealParams.lastBillTs];

            let tx = await market.Bill(presetFwdDealId, {from: supplier});

            let consumerBalanceAfter = await token.balanceOf(consumer);
            let supplierBalanceAfter = await token.balanceOf(supplier);

            let dealParamsAfter = await market.GetDealParams(presetFwdDealId);
            let dealInfoAfter = await market.GetDealInfo(presetFwdDealId, {from: consumer});

            let lastBillTSAfter = dealParamsAfter[DealParams.lastBillTs];

            let billPeriod = lastBillTSAfter.toNumber() - lastBillTSBefore.toNumber();

            // check event
            let event = await eventInTransaction(tx, 'Billed');
            assert.equal(event.paidAmount.toNumber(), billPeriod * oraclePrice * testPrice / 1e18);

            // console.log(`consumer after: ${consumerBalanceAfter.toFixed()}`);
            // console.log(`consumer before: ${consumerBalanceBefore.toFixed()}`);
            // console.log(`difference: ${consumerBalanceBefore.toNumber() - consumerBalanceAfter.toNumber()}`);
            assert.equal(consumerBalanceAfter.toNumber(),
                consumerBalanceBefore.toNumber() - event.paidAmount.toNumber());

            // console.log(`supplier after: ${supplierBalanceAfter.toFixed()}`);
            // console.log(`supplier before: ${supplierBalanceBefore.toFixed()}`);
            // console.log(`difference: ${supplierBalanceAfter.toNumber() - supplierBalanceBefore.toNumber()}`);
            assert.equal(supplierBalanceAfter.toNumber(),
                supplierBalanceBefore.toNumber() + event.paidAmount.toNumber());
        });
    });

    describe('Workers:', () => {
        it('RegisterWorker', async () => {
            let tx = await market.RegisterWorker(master, {from: supplier});
            await eventInTransaction(tx, 'WorkerAnnounced')
        });

        it('ConfirmWorker', async () => {
            let stateBefore = await market.GetMaster(supplier);
            let tx = await market.ConfirmWorker(supplier, {from: master});
            let stateAfter = await market.GetMaster(supplier);
            assert.ok(stateBefore !== stateAfter && stateAfter === master);
            await eventInTransaction(tx, 'WorkerConfirmed')
        });

        it('RemoveWorker', async () => {
            let tx = await market.RemoveWorker(supplier, master, {from: master});
            let check = await market.GetMaster(supplier);
            assert.equal(check, supplier);
            await eventInTransaction(tx, 'WorkerRemoved')
        });
    });

    // what to test if we using this api already? all fields?
    // it('test GetDealInfo', async function () {
    //     await market.GetDealInfo(2);
    // });
    //
    // it('test GetDealParams', async function () {
    //     await market.GetDealParams(1);
    // });
    //
    // it('test GetOrderInfo', async function () {
    //     await market.GetOrderInfo(2);
    // });
    //
    // it('test GetOrderParams', async function () {
    //     await market.GetOrderParams(2);
    // });


    describe('Change requests', () => {
        let presetFwdDealId;
        let presetFwdDealInfo;
        let presetFwdDealParams;
        let presetSpotDealId;
        let presetSpotDealInfo;
        let presetSpotDealParams;

        before(async () => {
            let askId = await Ask({market, supplier});
            let bidId = await Bid({market, consumer});
            await market.OpenDeal(askId, bidId, {from: consumer});
            let bidParams = await market.GetOrderParams(bidId, {from: consumer});
            presetFwdDealId = bidParams[OrderParams.dealId];
            presetFwdDealInfo = await market.GetDealInfo(presetFwdDealId, {from: consumer});
            presetFwdDealParams = await market.GetDealParams(presetFwdDealId, {from: consumer});

            let saskId = await Ask({market, supplier, duration: 0});
            let sbidId = await Bid({market, consumer, duration: 0});
            await market.OpenDeal(saskId, sbidId, {from: consumer});
            let sbidParams = await market.GetOrderParams(sbidId, {from: consumer});
            presetSpotDealId = sbidParams[OrderParams.dealId];
            presetSpotDealInfo = await market.GetDealInfo(presetSpotDealId, {from: consumer});
            presetSpotDealParams = await market.GetDealParams(presetSpotDealId, {from: consumer});
        });

        it('create change request as supplier and close', async () => {
            let chReqsBefore = await market.GetChangeRequestsAmount();
            let newPrice = 1e2;
            let newDuration = 90000;
            let tx = await market.CreateChangeRequest(
                presetFwdDealId,
                newPrice,
                newDuration,
                {from: supplier});
            let chReqsAfter = await market.GetChangeRequestsAmount();
            assert.equal(chReqsBefore.toNumber() + 1, chReqsAfter.toNumber());
            let setEventArgs = await eventInTransaction(tx, 'DealChangeRequestSet');
            // console.log(`dealSetChangeRequest: ${JSON.stringify(setEventArgs)}`);
            // assert.equal(1, setEventArgs.changeRequestID);
            let updateEventArgs = await eventInTransaction(tx, 'DealChangeRequestUpdated');
            let events = await allEventsInTransaction(tx, 'DealChangeRequestUpdated');
            console.log(JSON.stringify(events));
            // console.log(`dealUpdateChangeRequest: ${JSON.stringify(updateEventArgs)}`);
            // assert.equal(0, updateEventArgs.changeRequestID);
            assert.equal(1, 0);
        });

        // it('create change request as consumer', async () => {
        //     let chReqsBefore = await market.GetChangeRequestsAmount();
        //     let newPrice = 1e20;
        //     let newDuration = 80000;
        //     let tx = await market.CreateChangeRequest(
        //         presetFwdDealId,
        //         newPrice,
        //         newDuration,
        //         {from: consumer});
        //     let chReqsAfter = await market.GetChangeRequestsAmount();
        //     assert.equal(chReqsBefore.toNumber(10) + 1, chReqsAfter.toNumber(10));
        //     let setEventArgs = await eventInTransaction(tx, 'DealChangeRequestSet');
        //     console.log(`changereq: ${setEventArgs.changeRequestID}`);
        //     assert.equal(2, setEventArgs.changeRequestID);
        //     let updateEventArgs = await eventInTransaction(tx, 'DealChangeRequestUpdated');
        //     console.log(`update changereq: ${updateEventArgs.changeRequestID}`)
        //     assert.equal(0, updateEventArgs.changeRequestID);
        // });

    });

    // it('test CreateChangeRequest for cancel: ask', async function () {
    //     let stateBefore = await market.GetChangeRequestsAmount();
    //     await market.CreateChangeRequest(1, 3, 100000, {from: supplier});
    //     let stateAfter = await market.GetChangeRequestsAmount();
    //     assert.equal(stateBefore.toNumber(10) + 1, stateAfter.toNumber(10));
    // });

    // it('test CancelChangeRequest after creation: ask', async function () {
    //     let lastCR = (await market.GetChangeRequestsAmount()).toNumber(10);
    //     let stateBefore = await market.GetChangeRequestInfo(lastCR);
    //     await market.CancelChangeRequest(lastCR, {from: supplier});
    //     let stateAfter = await market.GetChangeRequestInfo(lastCR);
    //     assert.ok(stateBefore[4] !== stateAfter[4]);
    // });
    //
    // it('test CreateChangeRequest for cancel: bid', async function () {
    //     let stateBefore = await market.GetChangeRequestsAmount();
    //     await market.CreateChangeRequest(1, 3, 100000, {from: consumer});
    //     let stateAfter = await market.GetChangeRequestsAmount();
    //     assert.equal(stateBefore.toNumber(10) + 1, stateAfter.toNumber(10));
    // });
    //
    // it('test CancelChangeRequest after creation: bid', async function () {
    //     let lastCR = (await market.GetChangeRequestsAmount()).toNumber(10);
    //     let stateBefore = await market.GetChangeRequestInfo(lastCR);
    //     await market.CancelChangeRequest(lastCR, {from: consumer});
    //     let stateAfter = await market.GetChangeRequestInfo(lastCR);
    //     assert.ok(stateBefore[4] !== stateAfter[4]);
    // });
    //
    // it('test CreateChangeRequest for rejecting: bid', async function () {
    //     let stateBefore = await market.GetChangeRequestsAmount();
    //     await market.CreateChangeRequest(3, 3, 100000, {from: consumer});
    //     let stateAfter = await market.GetChangeRequestsAmount();
    //     assert.equal(stateBefore.toNumber(10) + 1, stateAfter.toNumber(10));
    // });
    //
    // it('test CancelChangeRequest rejecting: ask', async function () {
    //     let lastCR = await market.GetChangeRequestsAmount();
    //     let stateBefore = await market.GetChangeRequestInfo(lastCR.toNumber(10));
    //     await market.CancelChangeRequest(lastCR.toNumber(10), {from: supplier});
    //     let stateAfter = await market.GetChangeRequestInfo(lastCR.toNumber(10));
    //     assert.ok(stateBefore[4] !== stateAfter[4]);
    // });
    //
    // it('test CreateChangeRequest for rejecting: ask', async function () {
    //     let stateBefore = await market.GetChangeRequestsAmount();
    //     await market.CreateChangeRequest(3, 3, 100000, {from: supplier});
    //     let stateAfter = await market.GetChangeRequestsAmount();
    //     assert.equal(stateBefore.toNumber(10) + 1, stateAfter.toNumber(10));
    // });
    //
    // it('test CancelChangeRequest rejecting: bid', async function () {
    //     let lastCR = await market.GetChangeRequestsAmount();
    //     let stateBefore = await market.GetChangeRequestInfo(lastCR.toNumber(10));
    //     await market.CancelChangeRequest(lastCR.toNumber(10), {from: consumer});
    //     let stateAfter = await market.GetChangeRequestInfo(lastCR.toNumber(10));
    //     assert.ok(stateBefore[4] !== stateAfter[4]);
    // });
    //
    // it('test CreateChangeRequest for spot deal: ask', async function () {
    //     await market.CreateChangeRequest(2, 2, 0, {from: supplier});
    // });
    //
    // it('test CreateChangeRequest for spot deal: bid', async function () {
    //     await increaseTime(2);
    //     await market.CreateChangeRequest(2, 2, 0, {from: consumer});
    //     let newState = await market.GetDealParams(2);
    //     let newPrice = newState[1].toNumber(10);
    //     assert.equal(2, newPrice);
    // });
    //
    // it('test CreateChangeRequest for forward deal: bid', async function () {
    //     await market.CreateChangeRequest(1, 2, 2999, {from: consumer});
    // });
    //
    // it('test CreateChangeRequest for forward deal: ask', async function () {
    //     await increaseTime(2);
    //     await market.CreateChangeRequest(1, 2, 3000, {from: supplier});
    //     let newState = await market.GetDealParams(1);
    //     let newPrice = newState[1].toNumber(10);
    //     let newDuration = newState[0].toNumber(10);
    //     assert.equal(2, newPrice);
    //     assert.equal(2999, newDuration);
    // });
    //
    // it('test CreateChangeRequest for forward deal: automatch bid', async function () {
    //     let stateBefore = await market.GetDealParams(1);
    //     let oldPrice = stateBefore[1].toNumber(10);
    //     let oldDuration = stateBefore[0].toNumber(10);
    //     await market.CreateChangeRequest(1, 3, oldDuration, {from: consumer});
    //     let newState = await market.GetDealParams(1);
    //     let newPrice = newState[1].toNumber(10);
    //     let newDuration = newState[0].toNumber(10);
    //     assert.ok(oldPrice < newPrice);
    //     assert.equal(oldDuration, newDuration);
    // });
    //
    // it('test re-OpenDeal forward: close it with blacklist', async function () {
    //     await market.PlaceOrder(
    //         OrderType.ASK, // type
    //         '0x0', // counter_party
    //         5, // duration
    //         1, // price
    //         [0, 0, 0], // netflags
    //         IdentityLevel.ANONIMOUS, // identity level
    //         0x0, // blacklist
    //         '00000', // tag
    //         benchmarks, // benchmarks
    //         {from: supplier});
    //
    //     await market.PlaceOrder(
    //         OrderType.BID, // type
    //         '0x0', // counter_party
    //         4, // duration
    //         1, // price
    //         [0, 0, 0], // netflags
    //         IdentityLevel.ANONIMOUS, // identity level
    //         0x0, // blacklist
    //         '00000', // tag
    //         benchmarks, // benchmarks
    //         {from: consumer});
    //     let ordersAmount = await market.GetOrdersAmount();
    //     ordersAmount = ordersAmount.toNumber(10);
    //     let stateBefore = await market.GetDealsAmount();
    //     await market.OpenDeal(ordersAmount - 1, ordersAmount, {from: consumer});
    //     let stateAfter = await market.GetDealsAmount();
    //     await increaseTime(2);
    //     assert.equal(stateBefore.toNumber(10) + 1, stateAfter.toNumber(10));
    // });


    describe('Paid amount and blocked balance', async () => {
        it('Close deal when next period sum > consumer balance', async function () {
            await oracle.setCurrentPrice(1e12);
            let askId = await Ask({market, supplier, price: 1e6, duration: 0});
            let bidId = await Bid({market, consumer: specialConsumer2, price: 1e6, duration: 0});
            await market.OpenDeal(askId, bidId, {from: specialConsumer2});
            let dealId = await getDealIdFromOrder(market,specialConsumer2, askId);
            increaseTime(3600);
            await market.Bill(dealId, {from: supplier});
            let stateAfterClose = await market.GetDealParams(dealId);
            await market.GetDealInfo(dealId);
            assert.equal(stateAfterClose[3].toNumber(10), 2);
        });

        it('Close deal when paid amount > blocked balance, not enough money', async function () {
            await oracle.setCurrentPrice(1e12);
            let askId = await Ask({market, supplier, price: 1e6, duration: 0});
            let bidId = await Bid({market, consumer: specialConsumer, price: 1e6, duration: 0});

            await market.OpenDeal(askId, bidId, {from: specialConsumer});
            let dealId = await getDealIdFromOrder(market, askId);

            let stateAfterOpen = await market.GetDealParams(dealId);
            await increaseTime(2);

            await oracle.setCurrentPrice(1e18);
            await market.CloseDeal(dealId, false, {from: specialConsumer});
            let stateAfterClose = await market.GetDealParams(dealId);
            assert.equal(stateAfterClose[3].toNumber(10), 2);
            assert.equal(stateAfterClose[4].toNumber(10), 0); // balance
            assert.equal(stateAfterClose[5].toNumber(10), 3600); // payout
            assert.equal(stateAfterOpen[3].toNumber(10), 1);
            assert.equal(stateAfterOpen[4].toNumber(10), 3600); // balance
            assert.equal(stateAfterOpen[5].toNumber(10), 0); // payout
        });

        it('Close deal when paid amount > blocked balance', async function () {
            await oracle.setCurrentPrice(1e12);
            let askId = await Ask({market, supplier, price: 1e6, duration: 0});
            let bidId = await Bid({market, consumer, price: 1e6, duration: 0});

            await market.OpenDeal(askId, bidId, {from: consumer});
            let dealId = await getDealIdFromOrder(market, askId);
            let stateAfterOpen = await market.GetDealParams(dealId);
            await increaseTime(2);

            await oracle.setCurrentPrice(1e18);

            await market.CloseDeal(dealId, false, {from: consumer});
            let stateAfterClose = await market.GetDealParams(dealId);
            let infoAfterClose = await market.GetDealInfo(dealId);
            let dealTime = stateAfterClose[2].toNumber(10) - infoAfterClose[6].toNumber(10);
            assert.equal(stateAfterClose[3].toNumber(10), 2);
            assert.equal(stateAfterClose[4].toNumber(10), 3600000000); // balance
            assert.equal(stateAfterClose[5].toNumber(10), dealTime * 1e18 * 1e6 / 1e18); // payout
            assert.equal(stateAfterOpen[3].toNumber(10), 1);
            assert.equal(stateAfterOpen[4].toNumber(10), 3600); // balance
            assert.equal(stateAfterOpen[5].toNumber(10), 0); // payout
        });

    });

    // it('test create deal from spot BID and forward ASK and close with blacklist', async function () {
    //     await oracle.setCurrentPrice(1e12);
    //     await market.PlaceOrder(
    //         OrderType.ASK, // type
    //         '0x0', // counter_party
    //         36000, // duration
    //         1e6, // price
    //         [0, 0, 0], // netflags
    //         IdentityLevel.ANONIMOUS, // identity level
    //         0x0, // blacklist
    //         '00000', // tag
    //         benchmarks, // benchmarks
    //         {from: blacklistedSupplier});
    //
    //     await market.PlaceOrder(
    //         OrderType.BID, // type
    //         '0x0', // counter_party
    //         0, // duration
    //         1e6, // price
    //         [0, 0, 0], // netflags
    //         IdentityLevel.ANONIMOUS, // identity level
    //         0x0, // blacklist
    //         '00000', // tag
    //         benchmarks, // benchmarks
    //         {from: consumer});
    //     let ordersAmount = await market.GetOrdersAmount();
    //     ordersAmount = ordersAmount.toNumber(10);
    //     let stateBefore = await market.GetDealsAmount();
    //     await market.OpenDeal(ordersAmount - 1, ordersAmount, {from: consumer});
    //     let dealId = (await market.GetDealsAmount()).toNumber(10);
    //
    //     let stateAfter = await market.GetDealsAmount();
    //     await market.GetDealParams(dealId);
    //     await increaseTime(2);
    //     assert.equal(stateBefore.toNumber(10) + 1, stateAfter.toNumber(10));
    //
    //     await oracle.setCurrentPrice(1e18);
    //
    //     await market.CloseDeal(dealId, true, {from: consumer});
    //     let blacklisted = await blacklist.Check(consumer, blacklistedSupplier);
    //     assert.ok(blacklisted);
    // });
    //
    // it('test create deal from spot BID and forward ASK with blacklisted supplier', async function () {
    //     await oracle.setCurrentPrice(1e12);
    //     await market.PlaceOrder(
    //         OrderType.ASK, // type
    //         '0x0', // counter_party
    //         36000, // duration
    //         1e6, // price
    //         [0, 0, 0], // netflags
    //         IdentityLevel.ANONIMOUS, // identity level
    //         0x0, // blacklist
    //         '00000', // tag
    //         benchmarks, // benchmarks
    //         {from: blacklistedSupplier});
    //
    //     await market.PlaceOrder(
    //         OrderType.BID, // type
    //         '0x0', // counter_party
    //         0, // duration
    //         1e6, // price
    //         [0, 0, 0], // netflags
    //         IdentityLevel.ANONIMOUS, // identity level
    //         0x0, // blacklist
    //         '00000', // tag
    //         benchmarks, // benchmarks
    //         {from: consumer});
    //     let ordersAmount = await market.GetOrdersAmount();
    //     ordersAmount = ordersAmount.toNumber(10);
    //     await assertRevert(market.OpenDeal(ordersAmount - 1, ordersAmount, {from: consumer}));
    // });
    //
    // it('test CreateChangeRequest for forward deal: fullcheck ask', async function () {
    //     let stateBefore = await market.GetDealParams(4);
    //     let oldPrice = stateBefore[1].toNumber(10);
    //     let oldDuration = stateBefore[0].toNumber(10);
    //     await market.CreateChangeRequest(4, 2, 100, {from: supplier});
    //     let newState = await market.GetDealParams(4);
    //     let newPrice = newState[1].toNumber(10);
    //     let newDuration = newState[0].toNumber(10);
    //     assert.ok(newPrice === oldPrice);
    //     assert.ok(newDuration === oldDuration);
    //     let a = (await market.GetChangeRequestsAmount()).toNumber(10);
    //     await market.GetChangeRequestInfo(a);
    // });
    //
    // it('test CreateChangeRequest for forward deal: fullcheck bid', async function () {
    //     await increaseTime(1);
    //     let stateBefore = await market.GetDealParams(4);
    //     let oldPrice = stateBefore[1].toNumber(10);
    //     let oldDuration = stateBefore[0].toNumber(10);
    //     await market.CreateChangeRequest(4, 3, 99, {from: consumer});
    //     let newState = await market.GetDealParams(4);
    //     let newPrice = newState[1].toNumber(10);
    //     let newDuration = newState[0].toNumber(10);
    //     assert.ok(newPrice > oldPrice);
    //     assert.ok(newDuration > oldDuration);
    // });
    //
    // it('test Bill delayed I: spot', async function () {
    //     await increaseTime(2);
    //     await market.Bill(2, {from: supplier});
    // });
    //
    // it('test Bill delayed II: spot', async function () {
    //     await increaseTime(2);
    //     await market.Bill(2, {from: supplier});
    // });
    //
    // it('test CloseDeal: spot w/o blacklist', async function () {
    //     await market.CloseDeal(2, false, {from: supplier});
    //     let stateAfter = await market.GetDealParams(2);
    //     assert.equal(stateAfter[3].toNumber(10), 2);
    // });
    //
    // it('test CloseDeal: closing after ending', async function () {
    //     await market.CloseDeal(3, false, {from: supplier});
    //     let stateAfter = await market.GetDealParams(3);
    //     assert.equal(stateAfter[3].toNumber(10), 2);
    // });
    //
    // it('test CloseDeal: forward w blacklist', async function () {
    //     await market.CloseDeal(4, true, {from: consumer});
    //     let stateAfter = await market.GetDealParams(4);
    //     assert.equal(stateAfter[3].toNumber(10), 2);
    // });
    //

    //
    // it('test Set new blacklist', async function () {
    //     let newBL = await Blacklist.new();
    //     await market.SetBlacklistAddress(newBL.address);
    // });
    //
    // it('test Set new pr', async function () {
    //     let newPR = await ProfileRegistry.new();
    //     await market.SetProfileRegistryAddress(newPR.address);
    // });
    //
    // it('test Set new oracle', async function () {
    //     let newOracle = await OracleUSD.new();
    //     await newOracle.setCurrentPrice(20000000000000);
    //     await market.SetOracleAddress(newOracle.address);
    // });
    //
    // it('test QuickBuy', async function () {
    //     let stateBefore = await market.GetOrdersAmount();
    //     let dealsBefore = await market.GetDealsAmount();
    //     await market.PlaceOrder(
    //         OrderType.ASK, // type
    //         '0x0', // counter_party
    //         testDuration, // duration
    //         testPrice, // price
    //         [0, 0, 0], // netflags
    //         IdentityLevel.ANONIMOUS, // identity level
    //         0x0, // blacklist
    //         '00000', // tag
    //         benchmarks, // benchmarks
    //         {from: supplier});
    //     let stateAfter = await market.GetOrdersAmount();
    //     assert.equal(stateBefore.toNumber(10) + 1, stateAfter.toNumber(10));
    //
    //     await market.QuickBuy(stateAfter, 10, {from: consumer});
    //     let dealsAfter = await market.GetDealsAmount();
    //     assert.equal(dealsBefore.toNumber(10) + 1, dealsAfter.toNumber(10));
    // });
    //
    // it('test QuickBuy w master', async function () {
    //     await market.RegisterWorker(master, {from: supplier});
    //     await market.ConfirmWorker(supplier, {from: master});
    //     let stateBefore = await market.GetOrdersAmount();
    //     let dealsBefore = await market.GetDealsAmount();
    //     await market.PlaceOrder(
    //         OrderType.ASK, // type
    //         '0x0', // counter_party
    //         testDuration, // duration
    //         testPrice, // price
    //         [0, 0, 0], // netflags
    //         IdentityLevel.ANONIMOUS, // identity level
    //         0x0, // blacklist
    //         '00000', // tag
    //         benchmarks, // benchmarks
    //         {from: supplier});
    //     let stateAfter = await market.GetOrdersAmount();
    //     assert.equal(stateBefore.toNumber(10) + 1, stateAfter.toNumber(10));
    //
    //     await market.QuickBuy(stateAfter, 10, {from: consumer});
    //     let dealsAfter = await market.GetDealsAmount();
    //     assert.equal(dealsBefore.toNumber(10) + 1, dealsAfter.toNumber(10));
    // });
    //
    // it('test re-OpenDeal forward: close it with blacklist', async function () {
    //     await market.PlaceOrder(
    //         OrderType.ASK, // type
    //         '0x0', // counter_party
    //         3600, // duration
    //         10, // price
    //         [0, 0, 0], // netflags
    //         IdentityLevel.ANONIMOUS, // identity level
    //         0x0, // blacklist
    //         '00000', // tag
    //         benchmarks, // benchmarks
    //         {from: consumer});
    //
    //     await market.PlaceOrder(
    //         OrderType.BID, // type
    //         '0x0', // counter_party
    //         3600, // duration
    //         10, // price
    //         [0, 0, 0], // netflags
    //         IdentityLevel.ANONIMOUS, // identity level
    //         0x0, // blacklist
    //         '00000', // tag
    //         benchmarks, // benchmarks
    //         {from: consumer});
    //     let ordersAmount = await market.GetOrdersAmount();
    //     ordersAmount = ordersAmount.toNumber(10);
    //     await market.GetDealsAmount();
    //     await market.OpenDeal(ordersAmount - 1, ordersAmount, {from: consumer});
    //     let stateAfter = await market.GetDealsAmount();
    //     await market.CloseDeal(stateAfter.toNumber(10), false, {from: consumer});
    // });
    //
    // it('test OpenDeal forward: close it after ending', async function () {
    //     await market.PlaceOrder(
    //         OrderType.ASK, // type
    //         '0x0', // counter_party
    //         3600, // duration
    //         10, // price
    //         [0, 0, 0], // netflags
    //         IdentityLevel.ANONIMOUS, // identity level
    //         0x0, // blacklist
    //         '00000', // tag
    //         benchmarks, // benchmarks
    //         {from: consumer});
    //
    //     await market.PlaceOrder(
    //         OrderType.BID, // type
    //         '0x0', // counter_party
    //         3600, // duration
    //         10, // price
    //         [0, 0, 0], // netflags
    //         IdentityLevel.ANONIMOUS, // identity level
    //         0x0, // blacklist
    //         '00000', // tag
    //         benchmarks, // benchmarks
    //         {from: consumer});
    //     let ordersAmount = await market.GetOrdersAmount();
    //     ordersAmount = ordersAmount.toNumber(10);
    //     await market.GetDealsAmount();
    //     await market.OpenDeal(ordersAmount - 1, ordersAmount, {from: consumer});
    //     let stateAfter = await market.GetDealsAmount();
    //     await increaseTime(2);
    //     await market.CloseDeal(stateAfter.toNumber(10), false, {from: consumer});
    // });
    //
    // it('test CreateOrder forward bid duration 2 hours', async function () {
    //     await oracle.setCurrentPrice(1e18, {from: accounts[0]});
    //     let stateBefore = await market.GetOrdersAmount();
    //     let balanceBefore = await token.balanceOf(consumer);
    //     await market.PlaceOrder(
    //         OrderType.BID, // type
    //         '0x0', // counter_party
    //         7200, // duration
    //         1e5, // price
    //         [0, 0, 0], // netflags
    //         IdentityLevel.ANONIMOUS, // identity level
    //         0x0, // blacklist
    //         '00000', // tag
    //         benchmarks, // benchmarks
    //         {from: consumer});
    //
    //     let stateAfter = await market.GetOrdersAmount();
    //     let balanceAfter = await token.balanceOf(consumer);
    //     assert.equal(stateBefore.toNumber(10) + 1, stateAfter.toNumber(10));
    //     assert.equal(balanceBefore.toNumber(10) - 7200 * 1e3, balanceAfter.toNumber(10));
    // });
    describe('Benchmarks tests', async () => {

        let newBenchmarks = [40, 21, 2, 256, 160, 1000, 1000, 6, 3, 1200, 1860000, 3000, 123];
        let newBenchmarksWZero = [40, 21, 2, 256, 160, 1000, 1000, 6, 3, 1200, 1860000, 3000, 0];

        it('Create deals with old and new benchmarks', async () => {
            await oracle.setCurrentPrice(oraclePrice);
            let askOld = await Ask({market, supplier});
            let bidOld = await Bid({market, consumer});

            await market.SetBenchmarksQuantity(13);

            let bidNew = await Bid({market, consumer, benchmarks: newBenchmarksWZero});
            let askNew = await Ask({market, supplier, benchmarks: newBenchmarks});

            let bidInfo = await market.GetOrderInfo(bidNew, {from: consumer});
            checkBenchmarks(bidInfo[orderInfo.benchmarks], newBenchmarksWZero);
            let askInfo = await market.GetOrderInfo(askNew, {from: consumer});
            checkBenchmarks(askInfo[orderInfo.benchmarks], newBenchmarks);

            await market.OpenDeal(askOld, bidNew, {from: consumer});
            await market.OpenDeal(askNew, bidOld, {from: consumer});

            await checkOrderStatus(market, supplier, askOld, OrderStatus.INACTIVE);
            await checkOrderStatus(market, supplier, bidOld, OrderStatus.INACTIVE);
            await checkOrderStatus(market, supplier, bidNew, OrderStatus.INACTIVE);
            await checkOrderStatus(market, supplier, askNew, OrderStatus.INACTIVE);

            let dealInfo1 = await getDealInfoFromOrder(market,consumer, bidNew);
            checkBenchmarks(dealInfo1[DealInfo.benchmarks], newBenchmarksWZero);
            let dealInfo2 = await getDealInfoFromOrder(market,consumer, askNew);
            checkBenchmarks(dealInfo2[DealInfo.benchmarks], newBenchmarks);
        });

        it('Create deal with new benchmarks', async () => {
            let bid = await Bid({market, consumer, benchmarks: newBenchmarksWZero});
            let ask = await Ask({market, supplier, benchmarks: newBenchmarks});
            await market.OpenDeal(ask, bid, {from: consumer});
            let dealInfo = await getDealInfoFromOrder(market, consumer, bid);
            checkBenchmarks(dealInfo[DealInfo.benchmarks], newBenchmarks);
        });

        it('UpdateBenchmarks count', async () => {
            await market.SetBenchmarksQuantity(20);
            assert.equal((await market.GetBenchmarksQuantity()).toNumber(10), 20);
            await assertRevert(market.SetBenchmarksQuantity(12));
        });

    });

    it('test SetProfileRegistryAddress: bug while we can cast any contract as valid (for example i cast token as a Profile Registry)', async () => { // eslint-disable-line max-len
        await market.SetProfileRegistryAddress(token.address);
        //TODO we need to do something with this. or not
    });
});
