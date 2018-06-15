import {
    benchmarkQuantity,
    billTolerance,
    BlackListPerson,
    ChangeRequestInfo,
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
    RequestStatus,
    secInDay,
    secInHour,
    testDuration,
    testPrice,
} from "./helpers/constants";
import increaseTime from './helpers/increaseTime';
import assertRevert from './helpers/assertRevert';
import {eventInTransaction} from './helpers/expectEvent';
import {Ask} from './helpers/ask'
import {Bid} from './helpers/bid'
import {checkBenchmarks, checkOrderStatus, getDealIdFromOrder, getDealInfoFromOrder} from "./helpers/common";
import {inspect} from "./helpers/printers";

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
    let specialSupplier = accounts[6];
    let blacklistWorker1 = accounts[7];
    let blacklistWorker2 = accounts[8];
    let blacklistMaster = accounts[9];
    let supplierWithMaster = accounts[10];

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
        await token.transfer(specialConsumer, 7200, {from: accounts[0]});
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

            let frozenSum = info[orderInfo.frozenSum];

            // freezed for one day only
            assert.equal(secInDay * oraclePrice * testPrice / 1e18, frozenSum.toNumber());

            let balanceAfter = await token.balanceOf(consumer);
            assert.equal(balanceBefore.toNumber() - frozenSum.toNumber(), balanceAfter.toNumber());

            let balance = await token.balanceOf(market.address);
            assert.equal(frozenSum.toNumber(), balance);
        });

        it('CreateOrder with duration < 1 day, sum freezed for duration', async () => {
            let balanceBefore = await token.balanceOf(consumer);
            let marketBalanceBefore = await token.balanceOf(market.address);

            let oid = await Bid({market, consumer, duration: secInDay / 2});

            let balanceAfter = await token.balanceOf(consumer);
            let marketBalanceAfter = await token.balanceOf(market.address);
            let marketDifference = marketBalanceAfter.toNumber() - marketBalanceBefore.toNumber();

            let info = await market.GetOrderInfo(oid, {from: consumer});
            let frozenSum = info[orderInfo.frozenSum];

            assert.equal(balanceBefore.toNumber() - frozenSum, balanceAfter.toNumber());
            assert.equal(frozenSum, marketDifference);
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
            let dealParams = await market.GetDealParams(dealId, {from: consumer});
            assert.equal(DealStatus.ACCEPTED, dealParams[DealParams.status]);
            assert.ok(dealInfo[DealInfo.startTime].toNumber() === dealParams[DealParams.lastBillTs].toNumber(), "lastBillTs not equal to startTime");
            assert.equal(secInDay, dealParams[DealParams.blockedBalance].toNumber(), "Incorrect deal param blockedBalance");
            assert.equal(dealInfo[DealInfo.startTime].toNumber() + testDuration, dealParams[DealParams.endTime].toNumber(), "Incorrect deal param endTime");
            assert.equal(0, dealParams[DealParams.totalPayout].toNumber(), "Incorrect deal param totalPayout");
            assert.equal(testDuration, dealParams[DealParams.duration].toNumber(), "Incorrect deal param duration");
            assert.equal(testPrice, dealParams[DealParams.price].toNumber(), "Incorrect deal param price");
            assert.equal(supplier, dealInfo[DealInfo.supplier], "Incorrect deal info supplier");
            assert.equal(consumer, dealInfo[DealInfo.consumer], "Incorrect deal info consumer");
            assert.equal(supplier, dealInfo[DealInfo.master], "Incorrect deal info master");
            assert.equal(askId, dealInfo[DealInfo.ask].toNumber(), "Incorrect deal info ask");
            checkBenchmarks(dealInfo[orderInfo.benchmarks], defaultBenchmarks);
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
            let dealParams = await market.GetDealParams(dealId, {from: consumer});
            assert.equal(DealStatus.ACCEPTED, dealParams[DealParams.status]);
            assert.ok(dealInfo[DealInfo.startTime].toNumber() === dealParams[DealParams.lastBillTs].toNumber(), "lastBillTs not equal to startTime");
            assert.equal(secInHour, dealParams[DealParams.blockedBalance].toNumber(), "Incorrect deal param blockedBalance");
            assert.equal(0, dealParams[DealParams.endTime].toNumber(), "Incorrect deal param endTime");
            assert.equal(0, dealParams[DealParams.totalPayout].toNumber(), "Incorrect deal param totalPayout");
            assert.equal(0, dealParams[DealParams.duration].toNumber(), "Incorrect deal param duration");
            assert.equal(testPrice, dealParams[DealParams.price].toNumber(), "Incorrect deal param price");
            assert.equal(supplier, dealInfo[DealInfo.supplier], "Incorrect deal info supplier");
            assert.equal(consumer, dealInfo[DealInfo.consumer], "Incorrect deal info consumer");
            assert.equal(supplier, dealInfo[DealInfo.master], "Incorrect deal info master");
            assert.equal(askId, dealInfo[DealInfo.ask].toNumber(), "Incorrect deal info ask");
            checkBenchmarks(dealInfo[orderInfo.benchmarks], defaultBenchmarks);
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

    describe('Workers:', () => {
        it('register worker', async () => {
            let tx = await market.RegisterWorker(master, {from: supplier});
            await eventInTransaction(tx, 'WorkerAnnounced')
        });

        it('confirm worker', async () => {
            let masterBefore = await market.GetMaster(supplier);
            let tx = await market.ConfirmWorker(supplier, {from: master});
            let masterAfter = await market.GetMaster(supplier);
            assert.ok(masterBefore !== masterAfter && masterAfter === master);
            await eventInTransaction(tx, 'WorkerConfirmed')
        });

        it('remove worker from master', async () => {
            let tx = await market.RemoveWorker(supplier, master, {from: master});
            let masterAfter = await market.GetMaster(supplier);
            assert.equal(masterAfter, supplier);
            await eventInTransaction(tx, 'WorkerRemoved')
        });

        it('register/confirm worker, remove master from worker', async () => {
            await market.RegisterWorker(master, {from: supplier});
            await market.ConfirmWorker(supplier, {from: master});

            let txRemove = await market.RemoveWorker(supplier, master, {from: supplier});
            await eventInTransaction(txRemove, 'WorkerRemoved');
            let masterAfter = await market.GetMaster(supplier);
            assert.equal(masterAfter, supplier);
        });
    });


    describe('Bills:', () => {
        let presetFwdDealId;
        let presetFwdDealInfo;
        let presetFwdDealParams;

        let presetMasterFwdDealId;
        let presetMasterFwdDealInfo;
        let presetMasterFwdDealParams;

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

            await market.RegisterWorker(master, {from: supplierWithMaster});
            await market.ConfirmWorker(supplierWithMaster, {from: master});
            let maskId = await Ask({market, supplier: supplierWithMaster});
            let mbidId = await Bid({market, consumer});
            await market.OpenDeal(maskId, mbidId, {from: consumer});
            let mbidParams = await market.GetOrderParams(mbidId, {from: consumer});
            presetMasterFwdDealId = mbidParams[OrderParams.dealId];
            presetMasterFwdDealInfo = await market.GetDealInfo(presetMasterFwdDealId, {from: consumer});
            presetMasterFwdDealParams = await market.GetDealParams(presetMasterFwdDealId, {from: consumer});

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
            let marketBalanceBefore = await token.balanceOf(market.address);

            let lastBillTSBefore = presetSpotDealParams[DealParams.lastBillTs];

            let tx = await market.Bill(presetSpotDealId, {from: supplier});

            let consumerBalanceAfter = await token.balanceOf(consumer);
            let supplierBalanceAfter = await token.balanceOf(supplier);
            let marketBalanceAfter = await token.balanceOf(market.address);

            let dealParamsAfter = await market.GetDealParams(presetSpotDealId);

            let lastBillTSAfter = dealParamsAfter[DealParams.lastBillTs];

            let billPeriod = lastBillTSAfter.toNumber() - lastBillTSBefore.toNumber();

            // check event
            let event = await eventInTransaction(tx, 'Billed');
            assert.equal(event.paidAmount.toNumber(), billPeriod * oraclePrice * testPrice / 1e18);

            // check balances
            assert.equal(consumerBalanceAfter.toNumber(),
                consumerBalanceBefore.toNumber() - event.paidAmount.toNumber());
            assert.equal(supplierBalanceAfter.toNumber(),
                supplierBalanceBefore.toNumber() + event.paidAmount.toNumber());
            assert.equal(marketBalanceAfter.toNumber() - marketBalanceBefore.toNumber(), 0);
        });

        it('billing forward deal', async function () {
            let deal = await market.GetDealParams(presetFwdDealId);
            let consumerBalanceBefore = await token.balanceOf(consumer);
            let supplierBalanceBefore = await token.balanceOf(supplier);
            let marketBalanceBefore = await token.balanceOf(market.address);

            let lastBillTSBefore = deal[DealParams.lastBillTs];

            let tx = await market.Bill(presetFwdDealId, {from: supplier});

            let consumerBalanceAfter = await token.balanceOf(consumer);
            let supplierBalanceAfter = await token.balanceOf(supplier);
            let marketBalanceAfter = await token.balanceOf(market.address);

            let dealParamsAfter = await market.GetDealParams(presetFwdDealId);

            let lastBillTSAfter = dealParamsAfter[DealParams.lastBillTs];

            let billPeriod = lastBillTSAfter.toNumber() - lastBillTSBefore.toNumber();

            // check event
            let event = await eventInTransaction(tx, 'Billed');
            assert.equal(event.paidAmount.toNumber(), billPeriod * oraclePrice * testPrice / 1e18);

            // check balances
            assert.equal(consumerBalanceAfter.toNumber(),
                consumerBalanceBefore.toNumber() - event.paidAmount.toNumber());
            assert.equal(supplierBalanceAfter.toNumber(),
                supplierBalanceBefore.toNumber() + event.paidAmount.toNumber());
            assert.equal(marketBalanceAfter.toNumber() - marketBalanceBefore.toNumber(), 0);
        });

        it('billing forward deal, with master', async function () {
            let deal = await market.GetDealParams(presetMasterFwdDealId);
            let consumerBalanceBefore = await token.balanceOf(consumer);
            let masterBalanceBefore = await token.balanceOf(master);
            let marketBalanceBefore = await token.balanceOf(market.address);

            let lastBillTSBefore = deal[DealParams.lastBillTs];

            let tx = await market.Bill(presetMasterFwdDealId, {from: supplierWithMaster});

            let consumerBalanceAfter = await token.balanceOf(consumer);
            let masterBalanceAfter = await token.balanceOf(master);
            let marketBalanceAfter = await token.balanceOf(market.address);

            let dealParamsAfter = await market.GetDealParams(presetMasterFwdDealId);

            let lastBillTSAfter = dealParamsAfter[DealParams.lastBillTs];

            let billPeriod = lastBillTSAfter.toNumber() - lastBillTSBefore.toNumber();

            // check event
            let event = await eventInTransaction(tx, 'Billed');
            assert.equal(event.paidAmount.toNumber(), billPeriod * oraclePrice * testPrice / 1e18);

            // check balances
            assert.equal(consumerBalanceAfter.toNumber(),
                consumerBalanceBefore.toNumber() - event.paidAmount.toNumber());
            assert.equal(masterBalanceAfter.toNumber(),
                masterBalanceBefore.toNumber() + event.paidAmount.toNumber());
            assert.equal(marketBalanceAfter.toNumber() - marketBalanceBefore.toNumber(), 0);

            await market.RemoveWorker(supplierWithMaster, master, {from: master});
        });
    });

    describe('Change requests', () => {
        let presetFwdDealId;
        let presetFwdDealInfo;
        let presetFwdDealParams;
        let presetSpotDealId;
        let presetSpotDealInfo;
        let presetSpotDealParams;

        let testPrice = 1e4;

        before(async () => {
            let askId = await Ask({market, supplier, price: testPrice});
            let bidId = await Bid({market, consumer, price: testPrice});
            await market.OpenDeal(askId, bidId, {from: consumer});
            let bidParams = await market.GetOrderParams(bidId, {from: consumer});
            presetFwdDealId = bidParams[OrderParams.dealId];
            presetFwdDealInfo = await market.GetDealInfo(presetFwdDealId, {from: consumer});
            presetFwdDealParams = await market.GetDealParams(presetFwdDealId, {from: consumer});

            let saskId = await Ask({market, supplier, price: testPrice, duration: 0});
            let sbidId = await Bid({market, consumer, price: testPrice, duration: 0});
            await market.OpenDeal(saskId, sbidId, {from: consumer});
            let sbidParams = await market.GetOrderParams(sbidId, {from: consumer});
            presetSpotDealId = sbidParams[OrderParams.dealId];
            presetSpotDealInfo = await market.GetDealInfo(presetSpotDealId, {from: consumer});
            presetSpotDealParams = await market.GetDealParams(presetSpotDealId, {from: consumer});
        });

        it('create change request as supplier and close', async () => {
            let chReqsBefore = await market.GetChangeRequestsAmount();

            // raising price
            let newPrice = 1e6;
            await market.CreateChangeRequest(
                presetFwdDealId,
                newPrice,
                testDuration,
                {from: supplier});

            // price not changed
            let dealParamsAfter = await market.GetDealParams(presetFwdDealId);
            let priceAfter = dealParamsAfter[DealParams.price].toNumber();
            assert.equal(testPrice, priceAfter);

            let chReqsAfter = await market.GetChangeRequestsAmount();
            let currentChReq = chReqsBefore.toNumber() + 1;
            assert.equal(currentChReq, chReqsAfter.toNumber());

            let chReqInfoBefore = await market.GetChangeRequestInfo(currentChReq);
            assert.equal(RequestStatus.REQUEST_CREATED, chReqInfoBefore[ChangeRequestInfo.status]);

            await market.CancelChangeRequest(currentChReq, {from: supplier});

            let chReqInfoAfter = await market.GetChangeRequestInfo(currentChReq);
            assert.equal(RequestStatus.REQUEST_CANCELED,
                chReqInfoAfter[ChangeRequestInfo.status]);
        });

        it('create change request as consumer and close', async () => {
            let chReqsBefore = await market.GetChangeRequestsAmount();

            // lowering price
            let newPrice = 1e2;
            await market.CreateChangeRequest(
                presetFwdDealId,
                newPrice,
                testDuration,
                {from: consumer});

            // price not changed
            let dealParamsAfter = await market.GetDealParams(presetFwdDealId);
            let priceAfter = dealParamsAfter[DealParams.price].toNumber();
            assert.equal(testPrice, priceAfter);

            let chReqsAfter = await market.GetChangeRequestsAmount();
            let currentChReq = chReqsBefore.toNumber() + 1;
            assert.equal(currentChReq, chReqsAfter.toNumber());

            let chReqInfoBefore = await market.GetChangeRequestInfo(currentChReq);
            assert.equal(RequestStatus.REQUEST_CREATED, chReqInfoBefore[ChangeRequestInfo.status]);

            await market.CancelChangeRequest(currentChReq, {from: consumer});

            let chReqInfoAfter = await market.GetChangeRequestInfo(currentChReq);
            assert.equal(RequestStatus.REQUEST_CANCELED,
                chReqInfoAfter[ChangeRequestInfo.status]);
        });

        it('create change request as consumer and reject as supplier', async () => {
            let chReqsBefore = await market.GetChangeRequestsAmount();

            // lowering price
            let newPrice = 1e2;
            await market.CreateChangeRequest(
                presetFwdDealId,
                newPrice,
                testDuration,
                {from: consumer});

            // price not changed
            let dealParamsAfter = await market.GetDealParams(presetFwdDealId);
            let priceAfter = dealParamsAfter[DealParams.price].toNumber();
            assert.equal(testPrice, priceAfter);

            let chReqsAfter = await market.GetChangeRequestsAmount();
            let currentChReq = chReqsBefore.toNumber() + 1;
            assert.equal(currentChReq, chReqsAfter.toNumber());

            let chReqInfoBefore = await market.GetChangeRequestInfo(currentChReq);
            assert.equal(RequestStatus.REQUEST_CREATED, chReqInfoBefore[ChangeRequestInfo.status]);

            //rejecting
            await market.CancelChangeRequest(currentChReq, {from: supplier});

            let chReqInfoAfter = await market.GetChangeRequestInfo(currentChReq);
            assert.equal(RequestStatus.REQUEST_REJECTED,
                chReqInfoAfter[ChangeRequestInfo.status]);
        });

        it('create change request as supplier and reject as consumer', async () => {
            let chReqsBefore = await market.GetChangeRequestsAmount();

            // raising price
            let newPrice = 1e6;
            await market.CreateChangeRequest(
                presetFwdDealId,
                newPrice,
                testDuration,
                {from: supplier});

            // price not changed
            let dealParamsAfter = await market.GetDealParams(presetFwdDealId);
            let priceAfter = dealParamsAfter[DealParams.price].toNumber();
            assert.equal(testPrice, priceAfter);

            let chReqsAfter = await market.GetChangeRequestsAmount();
            let currentChReq = chReqsBefore.toNumber() + 1;
            assert.equal(currentChReq, chReqsAfter.toNumber());

            let chReqInfoBefore = await market.GetChangeRequestInfo(currentChReq);
            assert.equal(RequestStatus.REQUEST_CREATED, chReqInfoBefore[ChangeRequestInfo.status]);

            //rejecting
            await market.CancelChangeRequest(currentChReq, {from: consumer});

            let chReqInfoAfter = await market.GetChangeRequestInfo(currentChReq);
            assert.equal(RequestStatus.REQUEST_REJECTED,
                chReqInfoAfter[ChangeRequestInfo.status]);
        });

        it('create change requests pair for forward deal, accept lower price', async () => {
            let newPrice = 1e3;
            increaseTime(20);

            await market.CreateChangeRequest(
                presetFwdDealId,
                newPrice,
                testDuration,
                {from: consumer});

            await market.CreateChangeRequest(
                presetFwdDealId,
                newPrice,
                testDuration,
                {from: supplier});

            let dealParamsAfter = await market.GetDealParams(presetFwdDealId, {from: consumer});

            let priceAfter = dealParamsAfter[DealParams.price].toNumber();
            assert.equal(newPrice, priceAfter);
        });

        it('create change requests pair for forward deal, duration changed', async () => {
            let newDuration = 80000;

            await market.CreateChangeRequest(
                presetFwdDealId,
                testPrice,
                newDuration,
                {from: consumer});

            await market.CreateChangeRequest(
                presetFwdDealId,
                testPrice,
                newDuration,
                {from: supplier});

            let dealParamsAfter = await market.GetDealParams(presetFwdDealId);
            let durationAfter = dealParamsAfter[DealParams.duration].toNumber();
            assert.equal(newDuration, durationAfter);
        });

        it('create change requests pair for spot deal, accept lower price', async () => {
            let newPrice = 1e3;
            increaseTime(20);

            await market.CreateChangeRequest(
                presetSpotDealId,
                newPrice,
                0,
                {from: consumer});

            await market.CreateChangeRequest(
                presetSpotDealId,
                newPrice,
                0,
                {from: supplier});

            let dealParamsAfter = await market.GetDealParams(presetSpotDealId, {from: consumer});

            let priceAfter = dealParamsAfter[DealParams.price].toNumber();
            assert.equal(newPrice, priceAfter);
        });

        it('create change requests pair for spot deal, duration not changed', async () => {
            await assertRevert(
                market.CreateChangeRequest(
                    presetSpotDealId,
                    testPrice,
                    80000,
                    {from: consumer})
            );
        });

        it('fast accept price raising request from consumer', async () => {
            let newPrice = 1e6;
            await market.CreateChangeRequest(
                presetFwdDealId,
                newPrice,
                80000,
                {from: consumer});

            // price changed
            let dealParamsAfter = await market.GetDealParams(presetFwdDealId);
            let priceAfter = dealParamsAfter[DealParams.price].toNumber();
            assert.equal(newPrice, priceAfter);
        });

        it('fast accept price lowering request from supplier', async () => {
            let newPrice = 1e3;
            await market.CreateChangeRequest(
                presetFwdDealId,
                newPrice,
                80000,
                {from: supplier});

            // price changed
            let dealParamsAfter = await market.GetDealParams(presetFwdDealId);
            let priceAfter = dealParamsAfter[DealParams.price].toNumber();
            assert.equal(newPrice, priceAfter);
        });
    });

    describe('Paid amount and blocked balance', async () => {
        it('Bill deal when next period sum > consumer balance', async () => {
            await oracle.setCurrentPrice(1e12);
            let balSuppBefore = await token.balanceOf(specialSupplier);
            let balConsBefore = await token.balanceOf(specialConsumer2);
            let balMarketBefore = await token.balanceOf(market.address);

            let bidId = await Bid({market, consumer: specialConsumer2, price: 1e6, duration: 0});
            let askId = await Ask({market, supplier: specialSupplier, price: 1e6, duration: 0});
            let balConsInterm = await token.balanceOf(specialConsumer2);
            assert.equal(balConsBefore.toNumber(10) - balConsInterm.toNumber(10), 3600, "incorrect consumer balance");

            await market.OpenDeal(askId, bidId, {from: specialConsumer2});
            let dealId = await getDealIdFromOrder(market, specialConsumer2, askId);
            let paramsBeforeBill = await market.GetDealParams(dealId);
            await increaseTime(secInHour - 3);

            assert.equal(paramsBeforeBill[DealParams.status].toNumber(10), DealStatus.ACCEPTED, "deal must be ACCEPTED");

            await market.Bill(dealId, {from: specialConsumer2});

            let balMarketAfter = await token.balanceOf(market.address);
            let balSuppAfter = await token.balanceOf(specialSupplier);
            let balConsAfter = await token.balanceOf(specialConsumer2);
            let paramsAfterBill = await market.GetDealParams(dealId);
            let infoAfterBill = await market.GetDealInfo(dealId);
            let dealTime = paramsAfterBill[DealParams.endTime].toNumber(10) - infoAfterBill[DealInfo.startTime].toNumber(10);
            assert.equal(paramsAfterBill[DealParams.totalPayout].toNumber(10), dealTime, "incorrect total payout");
            assert.equal(balSuppAfter.toNumber(10) - balSuppBefore.toNumber(10), paramsAfterBill[DealParams.totalPayout].toNumber(10), "supplier received incorrect amount");
            assert.equal(balConsBefore.toNumber(10) - balConsAfter.toNumber(10), paramsAfterBill[DealParams.totalPayout].toNumber(10), "incorrect consumer balance");
            assert.equal(paramsAfterBill[DealParams.status].toNumber(10), DealStatus.CLOSED, "deal doesn't closed!!");
            assert.equal(balMarketAfter.toNumber(10) - balMarketBefore.toNumber(10), 0, "Market balance changed!!");
        });

        it('Bill deal when paid amount > blocked balance, not enough money', async () => {
            await oracle.setCurrentPrice(1e12);
            let balSuppBefore = await token.balanceOf(supplier);
            let balConsBefore = await token.balanceOf(specialConsumer);
            let balMarketBefore = await token.balanceOf(market.address);
            let askId = await Ask({market, supplier, price: 1e6, duration: 0});
            let bidId = await Bid({market, consumer: specialConsumer, price: 1e6, duration: 0});

            await market.OpenDeal(askId, bidId, {from: specialConsumer});
            let dealId = await getDealIdFromOrder(market, supplier, askId);

            await increaseTime(secInHour - 3);

            await oracle.setCurrentPrice(1e13);
            await market.Bill(dealId, {from: specialConsumer});

            let balMarketAfter = await token.balanceOf(market.address);
            let balSuppAfter = await token.balanceOf(supplier);
            let balConsAfter = await token.balanceOf(specialConsumer);
            let paramsAfterBill = await market.GetDealParams(dealId);
            assert.equal(paramsAfterBill[DealParams.totalPayout].toNumber(10), 3600, "incorrect total payout");
            assert.equal(balSuppAfter.toNumber(10) - balSuppBefore.toNumber(10), paramsAfterBill[DealParams.totalPayout].toNumber(10), "supplier received incorrect amount");
            assert.equal(balConsBefore.toNumber(10) - balConsAfter.toNumber(10), paramsAfterBill[DealParams.totalPayout].toNumber(10), "incorrect consumer balance");
            assert.equal(paramsAfterBill[DealParams.status].toNumber(10), DealStatus.CLOSED, "deal doesn't closed!!");
            assert.equal(balMarketAfter.toNumber(10) - balMarketBefore.toNumber(10), 0, "Market balance changed!!");
        });

        it('Bill deal when paid amount > blocked balance', async () => {
            let priceBefore = 1e12;
            let priceAfter = 2e12;
            await oracle.setCurrentPrice(priceBefore);
            let balSuppBefore = await token.balanceOf(supplier);
            let balConsBefore = await token.balanceOf(consumer);
            let balMarketBefore = await token.balanceOf(market.address);
            let askId = await Ask({market, supplier, price: 1e6, duration: 0});
            let bidId = await Bid({market, consumer, price: 1e6, duration: 0});

            await market.OpenDeal(askId, bidId, {from: consumer});
            let dealId = await getDealIdFromOrder(market, consumer, askId);
            await increaseTime(secInHour - 3);

            await oracle.setCurrentPrice(priceAfter);
            await market.Bill(dealId, {from: consumer});

            let balSuppAfter = await token.balanceOf(supplier);
            let balConsAfter = await token.balanceOf(consumer);
            let balMarketAfter = await token.balanceOf(market.address);
            let paramsAfterBill = await market.GetDealParams(dealId);
            let infoAfterBill = await market.GetDealInfo(dealId);
            let dealTime = paramsAfterBill[DealParams.lastBillTs].toNumber(10) - infoAfterBill[DealInfo.startTime].toNumber(10);

            assert.equal(paramsAfterBill[DealParams.totalPayout].toNumber(10), priceAfter / priceBefore * dealTime, "incorrect total payout");
            assert.equal(balSuppAfter.toNumber(10) - balSuppBefore.toNumber(10), paramsAfterBill[DealParams.totalPayout].toNumber(10), "supplier received incorrect amount");
            assert.equal(balConsBefore.toNumber(10) - balConsAfter.toNumber(10),
                paramsAfterBill[DealParams.totalPayout].toNumber(10) + paramsAfterBill[DealParams.blockedBalance].toNumber(10),
                "incorrect consumer balance");
            assert.equal(paramsAfterBill[DealParams.status].toNumber(10), DealStatus.ACCEPTED, "deal doesn't ACCEPTED!!");
            assert.equal(balMarketAfter.toNumber(10) - balMarketBefore.toNumber(10), paramsAfterBill[DealParams.blockedBalance].toNumber(10), "Incorrect market balance");
        });

        it('Close deal when paid amount > blocked balance', async () => {
            let priceBefore = 1e12;
            let priceAfter = 2e12;
            await oracle.setCurrentPrice(priceBefore);
            let balSuppBefore = await token.balanceOf(supplier);
            let balConsBefore = await token.balanceOf(consumer);
            let balMarketBefore = await token.balanceOf(market.address);
            let askId = await Ask({market, supplier, price: 1e6, duration: 0});
            let bidId = await Bid({market, consumer, price: 1e6, duration: 0});

            await market.OpenDeal(askId, bidId, {from: consumer});
            let dealId = await getDealIdFromOrder(market, consumer, askId);
            await increaseTime(secInHour - 3);

            await oracle.setCurrentPrice(priceAfter);
            await market.CloseDeal(dealId, 0, {from: consumer});

            let balSuppAfter = await token.balanceOf(supplier);
            let balConsAfter = await token.balanceOf(consumer);
            let balMarketAfter = await token.balanceOf(market.address);
            let paramsAfterBill = await market.GetDealParams(dealId);
            let infoAfterBill = await market.GetDealInfo(dealId);
            let dealTime = paramsAfterBill[DealParams.endTime].toNumber(10) - infoAfterBill[DealInfo.startTime].toNumber(10);
            assert.equal(paramsAfterBill[DealParams.totalPayout].toNumber(10), priceAfter / priceBefore * dealTime, "incorrect total payout");
            assert.equal(balSuppAfter.toNumber(10) - balSuppBefore.toNumber(10), paramsAfterBill[DealParams.totalPayout].toNumber(10), "supplier received incorrect amount");
            assert.equal(balConsBefore.toNumber(10) - balConsAfter.toNumber(10), paramsAfterBill[DealParams.totalPayout].toNumber(10), "incorrect consumer balance");
            assert.equal(paramsAfterBill[DealParams.status].toNumber(10), DealStatus.CLOSED, "deal doesn't closed!!");
            assert.equal(balMarketAfter.toNumber(10) - balMarketBefore.toNumber(10), 0, "Market balance changed!!");
        });

        it('test CloseDeal: closing after ending', async () => {
            await oracle.setCurrentPrice(1e12);
            let balSuppBefore = await token.balanceOf(supplier);
            let balConsBefore = await token.balanceOf(consumer);
            let balMarketBefore = await token.balanceOf(market.address);

            let bidId = await Bid({market, consumer: consumer, price: 1e6, duration: 3600});
            let askId = await Ask({market, supplier: supplier, price: 1e6, duration: 3600});
            let balConsInterm = await token.balanceOf(consumer);
            assert.equal(balConsBefore.toNumber(10) - balConsInterm.toNumber(10), 3600, "incorrect consumer balance");

            await market.OpenDeal(askId, bidId, {from: consumer});
            let dealId = await getDealIdFromOrder(market, consumer, askId);
            let paramsBeforeBill = await market.GetDealParams(dealId);
            await increaseTime(secInHour + 3);

            assert.equal(paramsBeforeBill[DealParams.status].toNumber(10), DealStatus.ACCEPTED, "deal must be ACCEPTED");

            await market.CloseDeal(dealId, 0, {from: consumer});

            let balMarketAfter = await token.balanceOf(market.address);
            let balSuppAfter = await token.balanceOf(supplier);
            let balConsAfter = await token.balanceOf(consumer);
            let paramsAfterBill = await market.GetDealParams(dealId);
            assert.equal(paramsAfterBill[DealParams.totalPayout].toNumber(10), 3600, "incorrect total payout");
            assert.equal(balSuppAfter.toNumber(10) - balSuppBefore.toNumber(10), paramsAfterBill[DealParams.totalPayout].toNumber(10), "supplier received incorrect amount");
            assert.equal(balConsBefore.toNumber(10) - balConsAfter.toNumber(10), paramsAfterBill[DealParams.totalPayout].toNumber(10), "incorrect consumer balance");
            assert.equal(paramsAfterBill[DealParams.status].toNumber(10), DealStatus.CLOSED, "deal doesn't closed!!");
            assert.equal(balMarketAfter.toNumber(10) - balMarketBefore.toNumber(10), 0, "Market balance changed!!");
        });

        it('test CloseDeal: closing before ending', async () => {
            await oracle.setCurrentPrice(1e12);
            let balSuppBefore = await token.balanceOf(supplier);
            let balConsBefore = await token.balanceOf(consumer);
            let balMarketBefore = await token.balanceOf(market.address);

            let bidId = await Bid({market, consumer: consumer, price: 1e6, duration: 3600});
            let askId = await Ask({market, supplier: supplier, price: 1e6, duration: 3600});
            let balConsInterm = await token.balanceOf(consumer);
            assert.equal(balConsBefore.toNumber(10) - balConsInterm.toNumber(10), 3600, "incorrect consumer balance");

            await market.OpenDeal(askId, bidId, {from: consumer});
            let dealId = await getDealIdFromOrder(market, consumer, askId);
            let paramsBeforeBill = await market.GetDealParams(dealId);
            await increaseTime(secInHour / 2);

            assert.equal(paramsBeforeBill[DealParams.status].toNumber(10), DealStatus.ACCEPTED, "deal must be ACCEPTED");

            await market.CloseDeal(dealId, 0, {from: consumer});

            let balMarketAfter = await token.balanceOf(market.address);
            let balSuppAfter = await token.balanceOf(supplier);
            let balConsAfter = await token.balanceOf(consumer);
            let paramsAfterBill = await market.GetDealParams(dealId);
            let infoAfterBill = await market.GetDealInfo(dealId);
            let dealTime = paramsAfterBill[DealParams.endTime].toNumber(10) - infoAfterBill[DealInfo.startTime].toNumber(10);
            assert.equal(paramsAfterBill[DealParams.totalPayout].toNumber(10), dealTime, "incorrect total payout");
            assert.equal(balSuppAfter.toNumber(10) - balSuppBefore.toNumber(10), paramsAfterBill[DealParams.totalPayout].toNumber(10), "supplier received incorrect amount");
            assert.equal(balConsBefore.toNumber(10) - balConsAfter.toNumber(10), paramsAfterBill[DealParams.totalPayout].toNumber(10), "incorrect consumer balance");
            assert.equal(paramsAfterBill[DealParams.status].toNumber(10), DealStatus.CLOSED, "deal doesn't closed!!");
            assert.equal(balMarketAfter.toNumber(10) - balMarketBefore.toNumber(10), 0, "Market balance changed!!");
        });


        it('test CloseDeal: closing before ending from supplier', async () => {
            await oracle.setCurrentPrice(1e12);
            let bidId = await Bid({market, consumer: consumer, price: 1e6, duration: 3600});
            let askId = await Ask({market, supplier: supplier, price: 1e6, duration: 3600});
            await market.OpenDeal(askId, bidId, {from: consumer});
            let dealId = await getDealIdFromOrder(market, consumer, askId);
            await increaseTime(secInHour / 2);
            await assertRevert(market.CloseDeal(dealId, 0, {from: supplier}));
        });
    });

    describe('Blacklist', async () => {
        it('prepare workers', async () => {
            await market.RegisterWorker(blacklistMaster, {from: blacklistWorker1});
            await market.RegisterWorker(blacklistMaster, {from: blacklistWorker2});
            await market.ConfirmWorker(blacklistWorker1, {from: blacklistMaster});
            await market.ConfirmWorker(blacklistWorker2, {from: blacklistMaster});
        });

        it('test create deal from spot BID and forward ASK and close with blacklist', async () => {
            await oracle.setCurrentPrice(1e12);

            let balSuppBefore = await token.balanceOf(blacklistMaster);
            let balConsBefore = await token.balanceOf(consumer);
            let balMarketBefore = await token.balanceOf(market.address);
            let askId = await Ask({market, supplier: blacklistWorker1, price: 1e6, duration: 3600});
            let bidId = await Bid({market, consumer, price: 1e6, duration: 0});

            await market.OpenDeal(askId, bidId, {from: consumer});
            let dealId = await getDealIdFromOrder(market, consumer, askId);
            await increaseTime(secInHour - 3);
            //close deal with blacklist worker blacklistWorker1
            await market.CloseDeal(dealId, 1, {from: consumer});
            let balSuppAfter = await token.balanceOf(blacklistMaster);
            let balConsAfter = await token.balanceOf(consumer);
            let balMarketAfter = await token.balanceOf(market.address);
            let paramsAfterClose = await market.GetDealParams(dealId);
            let infoAfterClose = await market.GetDealInfo(dealId);
            let dealTime = paramsAfterClose[DealParams.lastBillTs].toNumber(10) - infoAfterClose[DealInfo.startTime].toNumber(10);
            assert.equal(paramsAfterClose[DealParams.totalPayout].toNumber(10), dealTime, "incorrect total payout");
            assert.equal(balSuppAfter.toNumber(10) - balSuppBefore.toNumber(10), paramsAfterClose[DealParams.totalPayout].toNumber(10), "supplier received incorrect amount");
            assert.equal(balConsBefore.toNumber(10) - balConsAfter.toNumber(10), paramsAfterClose[DealParams.totalPayout].toNumber(10), "incorrect consumer balance");
            assert.equal(paramsAfterClose[DealParams.status].toNumber(10), DealStatus.CLOSED, "deal doesn't closed!!");
            assert.equal(balMarketAfter.toNumber(10) - balMarketBefore.toNumber(10), 0, "Market balance changed!!");
            let blacklisted1 = await blacklist.Check(consumer, blacklistWorker1);
            let blacklisted2 = await blacklist.Check(consumer, blacklistWorker2);
            let blacklistedMaster = await blacklist.Check(consumer, blacklistMaster);
            assert.ok(blacklisted1, "Worker blacklistWorker1 not blacklisted");
            assert.ok(!blacklisted2, "Worker blacklistWorker2 blacklisted");
            assert.ok(!blacklistedMaster, "blacklistMaster blacklisted");
        });

        it('test create deal from spot BID and forward ASK with blacklisted worker', async () => {
            let askId = await Ask({market, supplier: blacklistWorker1, price: 1e6, duration: 3600});
            let bidId = await Bid({market, consumer, price: 1e6, duration: 0});
            await assertRevert(market.OpenDeal(askId, bidId, {from: consumer}));
        });

        it('test create deal from spot BID and forward ASK with another worker', async () => {
            await oracle.setCurrentPrice(1e12);

            let balSuppBefore = await token.balanceOf(blacklistMaster);
            let balConsBefore = await token.balanceOf(consumer);
            let balMarketBefore = await token.balanceOf(market.address);
            let askId = await Ask({market, supplier: blacklistWorker2, price: 1e6, duration: 3600});
            let bidId = await Bid({market, consumer, price: 1e6, duration: 0});

            await market.OpenDeal(askId, bidId, {from: consumer});
            let dealId = await getDealIdFromOrder(market, consumer, askId);
            await increaseTime(secInHour - 3);
            //close deal with blacklist master
            await market.CloseDeal(dealId, 2, {from: consumer});
            let balSuppAfter = await token.balanceOf(blacklistMaster);
            let balConsAfter = await token.balanceOf(consumer);
            let balMarketAfter = await token.balanceOf(market.address);
            let paramsAfterClose = await market.GetDealParams(dealId);
            let infoAfterClose = await market.GetDealInfo(dealId);
            let dealTime = paramsAfterClose[DealParams.lastBillTs].toNumber(10) - infoAfterClose[DealInfo.startTime].toNumber(10);
            assert.equal(paramsAfterClose[DealParams.totalPayout].toNumber(10), dealTime, "incorrect total payout");
            assert.equal(balSuppAfter.toNumber(10) - balSuppBefore.toNumber(10), paramsAfterClose[DealParams.totalPayout].toNumber(10), "supplier received incorrect amount");
            assert.equal(balConsBefore.toNumber(10) - balConsAfter.toNumber(10), paramsAfterClose[DealParams.totalPayout].toNumber(10), "incorrect consumer balance");
            assert.equal(paramsAfterClose[DealParams.status].toNumber(10), DealStatus.CLOSED, "deal doesn't closed!!");
            assert.equal(balMarketAfter.toNumber(10) - balMarketBefore.toNumber(10), 0, "Market balance changed!!");
            let blacklisted1 = await blacklist.Check(consumer, blacklistWorker1);
            let blacklisted2 = await blacklist.Check(consumer, blacklistWorker2);
            let blacklistedMaster = await blacklist.Check(consumer, blacklistMaster);
            assert.ok(blacklisted1, "Worker blacklistWorker1 not blacklisted");
            assert.ok(!blacklisted2, "Worker blacklistWorker2 not blacklisted");
            assert.ok(blacklistedMaster, "blacklistMaster not blacklisted");
        });

        it('test create deal from spot BID and forward ASK with blacklisted master', async () => {
            let askId1 = await Ask({market, supplier: blacklistWorker2, price: 1e6, duration: 3600});
            let bidId1 = await Bid({market, consumer, price: 1e6, duration: 0});
            await assertRevert(market.OpenDeal(askId1, bidId1, {from: consumer}));

            let askId2 = await Ask({market, supplier: blacklistWorker1, price: 1e6, duration: 3600});
            let bidId2 = await Bid({market, consumer, price: 1e6, duration: 0});
            await assertRevert(market.OpenDeal(askId2, bidId2, {from: consumer}));
        });

    });

    describe('QuickBuy', async () => {
        it('test QuickBuy', async () => {
            await oracle.setCurrentPrice(1e12);
            let askId = await Ask({market, supplier, price: 1e6, duration: 3600});
            await market.QuickBuy(askId, 1800, {from: consumer});
            let dealId = await getDealIdFromOrder(market, consumer, askId);
            let dealInfo = await market.GetDealInfo(dealId, {from: consumer});
            let dealParams = await market.GetDealParams(dealId, {from: consumer});
            assert.equal(DealStatus.ACCEPTED, dealParams[DealParams.status]);
            assert.ok(dealInfo[DealInfo.startTime].toNumber() === dealParams[DealParams.lastBillTs].toNumber(), "lastBillTs not equal to startTime");
            assert.equal(1800, dealParams[DealParams.blockedBalance].toNumber(), "Incorrect deal param blockedBalance");
            assert.equal(dealInfo[DealInfo.startTime].toNumber() + 1800, dealParams[DealParams.endTime].toNumber(), "Incorrect deal param endTime");
            assert.equal(0, dealParams[DealParams.totalPayout].toNumber(), "Incorrect deal param totalPayout");
            assert.equal(1800, dealParams[DealParams.duration].toNumber(), "Incorrect deal param duration");
            assert.equal(1e6, dealParams[DealParams.price].toNumber(), "Incorrect deal param price");
            assert.equal(supplier, dealInfo[DealInfo.supplier], "Incorrect deal info supplier");
            assert.equal(consumer, dealInfo[DealInfo.consumer], "Incorrect deal info consumer");
            assert.equal(supplier, dealInfo[DealInfo.master], "Incorrect deal info master");
            assert.equal(askId, dealInfo[DealInfo.ask].toNumber(), "Incorrect deal info ask");
            checkBenchmarks(dealInfo[orderInfo.benchmarks], defaultBenchmarks);
        });

        it('test QuickBuy w master', async () => {
            await market.RegisterWorker(master, {from: supplier});
            await market.ConfirmWorker(supplier, {from: master});
            let askId = await Ask({market, supplier, price: 1e6, duration: 3600});
            await market.QuickBuy(askId, 10, {from: consumer});
            let dealId = await getDealIdFromOrder(market, consumer, askId);
            let dealInfo = await market.GetDealInfo(dealId, {from: consumer});
            let dealParams = await market.GetDealParams(dealId, {from: consumer});
            assert.equal(DealStatus.ACCEPTED, dealParams[DealParams.status]);
            assert.ok(dealInfo[DealInfo.startTime].toNumber() === dealParams[DealParams.lastBillTs].toNumber(), "lastBillTs not equal to startTime");
            assert.equal(10, dealParams[DealParams.blockedBalance].toNumber(), "Incorrect deal param blockedBalance");
            assert.equal(dealInfo[DealInfo.startTime].toNumber() + 10, dealParams[DealParams.endTime].toNumber(), "Incorrect deal param endTime");
            assert.equal(0, dealParams[DealParams.totalPayout].toNumber(), "Incorrect deal param totalPayout");
            assert.equal(10, dealParams[DealParams.duration].toNumber(), "Incorrect deal param duration");
            assert.equal(1e6, dealParams[DealParams.price].toNumber(), "Incorrect deal param price");
            assert.equal(supplier, dealInfo[DealInfo.supplier], "Incorrect deal info supplier");
            assert.equal(consumer, dealInfo[DealInfo.consumer], "Incorrect deal info consumer");
            assert.equal(master, dealInfo[DealInfo.master], "Incorrect deal info master");
            assert.equal(askId, dealInfo[DealInfo.ask].toNumber(), "Incorrect deal info ask");
            checkBenchmarks(dealInfo[orderInfo.benchmarks], defaultBenchmarks);
        });
    });

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

            let dealInfo1 = await getDealInfoFromOrder(market, consumer, bidNew);
            checkBenchmarks(dealInfo1[DealInfo.benchmarks], newBenchmarksWZero);
            let dealInfo2 = await getDealInfoFromOrder(market, consumer, askNew);
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

    describe('Other tests (setters etc..)', function () {
        it('test SetProfileRegistryAddress: bug while we can cast any contract as valid (for example i cast token as a Profile Registry)', async () => { // eslint-disable-line max-len
            await market.SetProfileRegistryAddress(token.address);
            //TODO we need to do something with this. or not
        });

        it('test Set new blacklist', async function () {
            let newBL = await Blacklist.new();
            await market.SetBlacklistAddress(newBL.address);
        });

        it('test Set new pr', async function () {
            let newPR = await ProfileRegistry.new();
            await market.SetProfileRegistryAddress(newPR.address);
        });

        it('test Set new oracle', async function () {
            let newOracle = await OracleUSD.new();
            await newOracle.setCurrentPrice(20000000000000);
            await market.SetOracleAddress(newOracle.address);
        });

    });

});
