/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { omit } from '@vendure/common/lib/omit';
import { pick } from '@vendure/common/lib/pick';
import {
    containsProducts,
    customerGroup,
    defaultShippingCalculator,
    defaultShippingEligibilityChecker,
    discountOnItemWithFacets,
    hasFacetValues,
    manualFulfillmentHandler,
    mergeConfig,
    minimumOrderAmount,
    orderPercentageDiscount,
    productsPercentageDiscount,
} from '@vendure/core';
import {
    createErrorResultGuard,
    createTestEnvironment,
    E2E_DEFAULT_CHANNEL_TOKEN,
    ErrorResultGuard,
} from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { testConfig, TEST_SETUP_TIMEOUT_MS } from '../../../e2e-common/test-config';
import { freeShipping } from '../src/config/promotion/actions/free-shipping-action';
import { orderFixedDiscount } from '../src/config/promotion/actions/order-fixed-discount-action';
import { orderLineFixedDiscount } from '../src/config/promotion/actions/order-line-fixed-discount-action';

import { TestMoneyStrategy } from './fixtures/test-money-strategy';
import { testSuccessfulPaymentMethod } from './fixtures/test-payment-methods';
import { CurrencyCode, HistoryEntryType, LanguageCode } from './graphql/generated-e2e-admin-types';
import * as Codegen from './graphql/generated-e2e-admin-types';
import { AdjustmentType, ErrorCode } from './graphql/generated-e2e-shop-types';
import * as CodegenShop from './graphql/generated-e2e-shop-types';
import {
    ASSIGN_PRODUCT_TO_CHANNEL,
    ASSIGN_PROMOTIONS_TO_CHANNEL,
    CANCEL_ORDER,
    CREATE_CHANNEL,
    CREATE_CUSTOMER_GROUP,
    CREATE_PROMOTION,
    CREATE_SHIPPING_METHOD,
    GET_FACET_LIST,
    GET_PRODUCTS_WITH_VARIANT_PRICES,
    REMOVE_CUSTOMERS_FROM_GROUP,
} from './graphql/shared-definitions';
import {
    ADD_ITEM_TO_ORDER,
    ADJUST_ITEM_QUANTITY,
    APPLY_COUPON_CODE,
    GET_ACTIVE_ORDER,
    GET_ORDER_PROMOTIONS_BY_CODE,
    REMOVE_COUPON_CODE,
    REMOVE_ITEM_FROM_ORDER,
    SET_CUSTOMER,
    SET_SHIPPING_METHOD,
} from './graphql/shop-definitions';
import { addPaymentToOrder, proceedToArrangingPayment } from './utils/test-order-utils';

describe('Promotions applied to Orders', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            dbConnectionOptions: { logging: true },
            paymentOptions: {
                paymentMethodHandlers: [testSuccessfulPaymentMethod],
            },
            entityOptions: {
                moneyStrategy: new TestMoneyStrategy(),
            },
        }),
    );

    const freeOrderAction = {
        code: orderPercentageDiscount.code,
        arguments: [{ name: 'discount', value: '100' }],
    };
    const minOrderAmountCondition = (min: number) => ({
        code: minimumOrderAmount.code,
        arguments: [
            { name: 'amount', value: min.toString() },
            { name: 'taxInclusive', value: 'true' },
        ],
    });

    type OrderSuccessResult = CodegenShop.UpdatedOrderFragment | CodegenShop.TestOrderFragmentFragment;
    const orderResultGuard: ErrorResultGuard<OrderSuccessResult> = createErrorResultGuard(
        input => !!input.lines,
    );

    let products: Codegen.GetProductsWithVariantPricesQuery['products']['items'];

    beforeAll(async () => {
        await server.init({
            initialData: {
                ...initialData,
                paymentMethods: [
                    {
                        name: testSuccessfulPaymentMethod.code,
                        handler: { code: testSuccessfulPaymentMethod.code, arguments: [] },
                    },
                ],
            },
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-promotions.csv'),
            customerCount: 2,
        });
        await adminClient.asSuperAdmin();

        await getProducts();
        await createGlobalPromotions();
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    describe('coupon codes', () => {
        const TEST_COUPON_CODE = 'TESTCOUPON';
        const EXPIRED_COUPON_CODE = 'EXPIRED';
        let promoFreeWithCoupon: Codegen.PromotionFragment;
        let promoFreeWithExpiredCoupon: Codegen.PromotionFragment;

        beforeAll(async () => {
            promoFreeWithCoupon = await createPromotion({
                enabled: true,
                name: 'Free with test coupon',
                couponCode: TEST_COUPON_CODE,
                conditions: [],
                actions: [freeOrderAction],
            });
            promoFreeWithExpiredCoupon = await createPromotion({
                enabled: true,
                name: 'Expired coupon',
                endsAt: new Date(2010, 0, 0),
                couponCode: EXPIRED_COUPON_CODE,
                conditions: [],
                actions: [freeOrderAction],
            });

            await shopClient.asAnonymousUser();
            await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: getVariantBySlug('item-5000').id,
                quantity: 1,
            });
        });

        afterAll(async () => {
            await deletePromotion(promoFreeWithCoupon.id);
            await deletePromotion(promoFreeWithExpiredCoupon.id);
        });

        it('applyCouponCode returns error result when code is nonexistant', async () => {
            const { applyCouponCode } = await shopClient.query<
                CodegenShop.ApplyCouponCodeMutation,
                CodegenShop.ApplyCouponCodeMutationVariables
            >(APPLY_COUPON_CODE, {
                couponCode: 'bad code',
            });
            orderResultGuard.assertErrorResult(applyCouponCode);
            expect(applyCouponCode.message).toBe('Coupon code "bad code" is not valid');
            expect(applyCouponCode.errorCode).toBe(ErrorCode.COUPON_CODE_INVALID_ERROR);
        });

        it('applyCouponCode returns error when code is expired', async () => {
            const { applyCouponCode } = await shopClient.query<
                CodegenShop.ApplyCouponCodeMutation,
                CodegenShop.ApplyCouponCodeMutationVariables
            >(APPLY_COUPON_CODE, {
                couponCode: EXPIRED_COUPON_CODE,
            });
            orderResultGuard.assertErrorResult(applyCouponCode);
            expect(applyCouponCode.message).toBe(`Coupon code "${EXPIRED_COUPON_CODE}" has expired`);
            expect(applyCouponCode.errorCode).toBe(ErrorCode.COUPON_CODE_EXPIRED_ERROR);
        });

        it('coupon code application is case-sensitive', async () => {
            const { applyCouponCode } = await shopClient.query<
                CodegenShop.ApplyCouponCodeMutation,
                CodegenShop.ApplyCouponCodeMutationVariables
            >(APPLY_COUPON_CODE, {
                couponCode: TEST_COUPON_CODE.toLowerCase(),
            });
            orderResultGuard.assertErrorResult(applyCouponCode);
            expect(applyCouponCode.message).toBe(
                `Coupon code "${TEST_COUPON_CODE.toLowerCase()}" is not valid`,
            );
            expect(applyCouponCode.errorCode).toBe(ErrorCode.COUPON_CODE_INVALID_ERROR);
        });

        it('applies a valid coupon code', async () => {
            const { applyCouponCode } = await shopClient.query<
                CodegenShop.ApplyCouponCodeMutation,
                CodegenShop.ApplyCouponCodeMutationVariables
            >(APPLY_COUPON_CODE, {
                couponCode: TEST_COUPON_CODE,
            });
            orderResultGuard.assertSuccess(applyCouponCode);
            expect(applyCouponCode.couponCodes).toEqual([TEST_COUPON_CODE]);
            expect(applyCouponCode.discounts.length).toBe(1);
            expect(applyCouponCode.discounts[0].description).toBe('Free with test coupon');
            expect(applyCouponCode.totalWithTax).toBe(0);
        });

        it('order history records application', async () => {
            const { activeOrder } = await shopClient.query<CodegenShop.GetActiveOrderQuery>(GET_ACTIVE_ORDER);

            expect(activeOrder!.history.items.map(i => omit(i, ['id']))).toEqual([
                {
                    type: HistoryEntryType.ORDER_STATE_TRANSITION,
                    data: {
                        from: 'Created',
                        to: 'AddingItems',
                    },
                },
                {
                    type: HistoryEntryType.ORDER_COUPON_APPLIED,
                    data: {
                        couponCode: TEST_COUPON_CODE,
                        promotionId: 'T_3',
                    },
                },
            ]);
        });

        it('de-duplicates existing codes', async () => {
            const { applyCouponCode } = await shopClient.query<
                CodegenShop.ApplyCouponCodeMutation,
                CodegenShop.ApplyCouponCodeMutationVariables
            >(APPLY_COUPON_CODE, {
                couponCode: TEST_COUPON_CODE,
            });
            orderResultGuard.assertSuccess(applyCouponCode);
            expect(applyCouponCode.couponCodes).toEqual([TEST_COUPON_CODE]);
        });

        it('removes a coupon code', async () => {
            const { removeCouponCode } = await shopClient.query<
                CodegenShop.RemoveCouponCodeMutation,
                CodegenShop.RemoveCouponCodeMutationVariables
            >(REMOVE_COUPON_CODE, {
                couponCode: TEST_COUPON_CODE,
            });

            expect(removeCouponCode!.discounts.length).toBe(0);
            expect(removeCouponCode!.totalWithTax).toBe(6000);
        });

        // https://github.com/vendure-ecommerce/vendure/issues/649
        it('discounts array cleared after coupon code removed', async () => {
            const { activeOrder } = await shopClient.query<CodegenShop.GetActiveOrderQuery>(GET_ACTIVE_ORDER);

            expect(activeOrder?.discounts).toEqual([]);
        });

        it('order history records removal', async () => {
            const { activeOrder } = await shopClient.query<CodegenShop.GetActiveOrderQuery>(GET_ACTIVE_ORDER);

            expect(activeOrder!.history.items.map(i => omit(i, ['id']))).toEqual([
                {
                    type: HistoryEntryType.ORDER_STATE_TRANSITION,
                    data: {
                        from: 'Created',
                        to: 'AddingItems',
                    },
                },
                {
                    type: HistoryEntryType.ORDER_COUPON_APPLIED,
                    data: {
                        couponCode: TEST_COUPON_CODE,
                        promotionId: 'T_3',
                    },
                },
                {
                    type: HistoryEntryType.ORDER_COUPON_REMOVED,
                    data: {
                        couponCode: TEST_COUPON_CODE,
                    },
                },
            ]);
        });

        it('does not record removal of coupon code that was not added', async () => {
            const { removeCouponCode } = await shopClient.query<
                CodegenShop.RemoveCouponCodeMutation,
                CodegenShop.RemoveCouponCodeMutationVariables
            >(REMOVE_COUPON_CODE, {
                couponCode: 'NOT_THERE',
            });

            expect(removeCouponCode!.history.items.map(i => omit(i, ['id']))).toEqual([
                {
                    type: HistoryEntryType.ORDER_STATE_TRANSITION,
                    data: {
                        from: 'Created',
                        to: 'AddingItems',
                    },
                },
                {
                    type: HistoryEntryType.ORDER_COUPON_APPLIED,
                    data: {
                        couponCode: TEST_COUPON_CODE,
                        promotionId: 'T_3',
                    },
                },
                {
                    type: HistoryEntryType.ORDER_COUPON_REMOVED,
                    data: {
                        couponCode: TEST_COUPON_CODE,
                    },
                },
            ]);
        });

        describe('coupon codes in other channels', () => {
            const OTHER_CHANNEL_TOKEN = 'other-channel';
            const OTHER_CHANNEL_COUPON_CODE = 'OTHER_CHANNEL_CODE';

            beforeAll(async () => {
                const { createChannel } = await adminClient.query<
                    Codegen.CreateChannelMutation,
                    Codegen.CreateChannelMutationVariables
                >(CREATE_CHANNEL, {
                    input: {
                        code: 'other-channel',
                        currencyCode: CurrencyCode.GBP,
                        pricesIncludeTax: false,
                        defaultTaxZoneId: 'T_1',
                        defaultShippingZoneId: 'T_1',
                        defaultLanguageCode: LanguageCode.en,
                        token: OTHER_CHANNEL_TOKEN,
                    },
                });

                await createPromotion({
                    enabled: true,
                    name: 'Other Channel Promo',
                    couponCode: OTHER_CHANNEL_COUPON_CODE,
                    conditions: [],
                    actions: [freeOrderAction],
                });
            });

            afterAll(() => {
                shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            });

            // https://github.com/vendure-ecommerce/vendure/issues/1692
            it('does not allow a couponCode from another channel', async () => {
                shopClient.setChannelToken(OTHER_CHANNEL_TOKEN);
                const { applyCouponCode } = await shopClient.query<
                    ApplyCouponCode.Mutation,
                    ApplyCouponCode.Variables
                >(APPLY_COUPON_CODE, {
                    couponCode: OTHER_CHANNEL_COUPON_CODE,
                });
                orderResultGuard.assertErrorResult(applyCouponCode);
                expect(applyCouponCode.errorCode).toEqual('COUPON_CODE_INVALID_ERROR');
            });
        });
    });

    describe('default PromotionConditions', () => {
        beforeEach(async () => {
            await shopClient.asAnonymousUser();
        });

        it('minimumOrderAmount', async () => {
            const promotion = await createPromotion({
                enabled: true,
                name: 'Free if order total greater than 100',
                conditions: [minOrderAmountCondition(10000)],
                actions: [freeOrderAction],
            });
            const { addItemToOrder } = await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: getVariantBySlug('item-5000').id,
                quantity: 1,
            });
            orderResultGuard.assertSuccess(addItemToOrder);
            expect(addItemToOrder.totalWithTax).toBe(6000);
            expect(addItemToOrder.discounts.length).toBe(0);

            const { adjustOrderLine } = await shopClient.query<
                CodegenShop.AdjustItemQuantityMutation,
                CodegenShop.AdjustItemQuantityMutationVariables
            >(ADJUST_ITEM_QUANTITY, {
                orderLineId: addItemToOrder.lines[0].id,
                quantity: 2,
            });
            orderResultGuard.assertSuccess(adjustOrderLine);
            expect(adjustOrderLine.totalWithTax).toBe(0);
            expect(adjustOrderLine.discounts[0].description).toBe('Free if order total greater than 100');
            expect(adjustOrderLine.discounts[0].amountWithTax).toBe(-12000);

            await deletePromotion(promotion.id);
        });

        it('atLeastNWithFacets', async () => {
            const { facets } = await adminClient.query<Codegen.GetFacetListQuery>(GET_FACET_LIST);
            const saleFacetValue = facets.items[0].values[0];
            const promotion = await createPromotion({
                enabled: true,
                name: 'Free if order contains 2 items with Sale facet value',
                conditions: [
                    {
                        code: hasFacetValues.code,
                        arguments: [
                            { name: 'minimum', value: '2' },
                            { name: 'facets', value: `["${saleFacetValue.id}"]` },
                        ],
                    },
                ],
                actions: [freeOrderAction],
            });

            const { addItemToOrder: res1 } = await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: getVariantBySlug('item-sale-100').id,
                quantity: 1,
            });
            orderResultGuard.assertSuccess(res1);
            expect(res1.totalWithTax).toBe(120);
            expect(res1.discounts.length).toBe(0);

            const { addItemToOrder: res2 } = await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: getVariantBySlug('item-sale-1000').id,
                quantity: 1,
            });
            orderResultGuard.assertSuccess(res2);
            expect(res2.totalWithTax).toBe(0);
            expect(res2.discounts.length).toBe(1);
            expect(res2.totalWithTax).toBe(0);
            expect(res2.discounts[0].description).toBe(
                'Free if order contains 2 items with Sale facet value',
            );
            expect(res2.discounts[0].amountWithTax).toBe(-1320);

            await deletePromotion(promotion.id);
        });

        it('containsProducts', async () => {
            const item5000 = getVariantBySlug('item-5000')!;
            const item1000 = getVariantBySlug('item-1000')!;
            const promotion = await createPromotion({
                enabled: true,
                name: 'Free if buying 3 or more offer products',
                conditions: [
                    {
                        code: containsProducts.code,
                        arguments: [
                            { name: 'minimum', value: '3' },
                            {
                                name: 'productVariantIds',
                                value: JSON.stringify([item5000.id, item1000.id]),
                            },
                        ],
                    },
                ],
                actions: [freeOrderAction],
            });
            await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: item5000.id,
                quantity: 1,
            });
            const { addItemToOrder } = await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: item1000.id,
                quantity: 1,
            });
            orderResultGuard.assertSuccess(addItemToOrder);
            expect(addItemToOrder.totalWithTax).toBe(7200);
            expect(addItemToOrder.discounts.length).toBe(0);

            const { adjustOrderLine } = await shopClient.query<
                CodegenShop.AdjustItemQuantityMutation,
                CodegenShop.AdjustItemQuantityMutationVariables
            >(ADJUST_ITEM_QUANTITY, {
                orderLineId: addItemToOrder.lines.find(l => l.productVariant.id === item5000.id)!.id,
                quantity: 2,
            });
            orderResultGuard.assertSuccess(adjustOrderLine);
            expect(adjustOrderLine.total).toBe(0);
            expect(adjustOrderLine.discounts[0].description).toBe('Free if buying 3 or more offer products');
            expect(adjustOrderLine.discounts[0].amountWithTax).toBe(-13200);

            await deletePromotion(promotion.id);
        });

        it('customerGroup', async () => {
            const { createCustomerGroup } = await adminClient.query<
                Codegen.CreateCustomerGroupMutation,
                Codegen.CreateCustomerGroupMutationVariables
            >(CREATE_CUSTOMER_GROUP, {
                input: { name: 'Test Group', customerIds: ['T_1'] },
            });

            await shopClient.asUserWithCredentials('hayden.zieme12@hotmail.com', 'test');

            const promotion = await createPromotion({
                enabled: true,
                name: 'Free for group members',
                conditions: [
                    {
                        code: customerGroup.code,
                        arguments: [{ name: 'customerGroupId', value: createCustomerGroup.id }],
                    },
                ],
                actions: [freeOrderAction],
            });

            const { addItemToOrder } = await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: getVariantBySlug('item-5000').id,
                quantity: 1,
            });
            orderResultGuard.assertSuccess(addItemToOrder);
            expect(addItemToOrder.totalWithTax).toBe(0);
            expect(addItemToOrder.discounts.length).toBe(1);
            expect(addItemToOrder.discounts[0].description).toBe('Free for group members');
            expect(addItemToOrder.discounts[0].amountWithTax).toBe(-6000);

            await adminClient.query<
                Codegen.RemoveCustomersFromGroupMutation,
                Codegen.RemoveCustomersFromGroupMutationVariables
            >(REMOVE_CUSTOMERS_FROM_GROUP, {
                groupId: createCustomerGroup.id,
                customerIds: ['T_1'],
            });

            const { adjustOrderLine } = await shopClient.query<
                CodegenShop.AdjustItemQuantityMutation,
                CodegenShop.AdjustItemQuantityMutationVariables
            >(ADJUST_ITEM_QUANTITY, {
                orderLineId: addItemToOrder.lines[0].id,
                quantity: 2,
            });
            orderResultGuard.assertSuccess(adjustOrderLine);
            expect(adjustOrderLine.totalWithTax).toBe(12000);
            expect(adjustOrderLine.discounts.length).toBe(0);

            await deletePromotion(promotion.id);
        });
    });

    describe('default PromotionActions', () => {
        const TAX_INCLUDED_CHANNEL_TOKEN = 'tax_included_channel';
        let taxIncludedChannel: Codegen.ChannelFragment;

        beforeAll(async () => {
            // Create a channel where the prices include tax, so we can ensure
            // that PromotionActions are working as expected when taxes are included
            const { createChannel } = await adminClient.query<
                Codegen.CreateChannelMutation,
                Codegen.CreateChannelMutationVariables
            >(CREATE_CHANNEL, {
                input: {
                    code: 'tax-included-channel',
                    currencyCode: CurrencyCode.GBP,
                    pricesIncludeTax: true,
                    defaultTaxZoneId: 'T_1',
                    defaultShippingZoneId: 'T_1',
                    defaultLanguageCode: LanguageCode.en,
                    token: TAX_INCLUDED_CHANNEL_TOKEN,
                },
            });
            taxIncludedChannel = createChannel as Codegen.ChannelFragment;
            await adminClient.query<
                Codegen.AssignProductsToChannelMutation,
                Codegen.AssignProductsToChannelMutationVariables
            >(ASSIGN_PRODUCT_TO_CHANNEL, {
                input: {
                    channelId: taxIncludedChannel.id,
                    priceFactor: 1,
                    productIds: products.map(p => p.id),
                },
            });
        });

        beforeEach(async () => {
            await shopClient.asAnonymousUser();
        });

        async function assignPromotionToTaxIncludedChannel(promotionId: string | string[]) {
            await adminClient.query<
                Codegen.AssignPromotionToChannelMutation,
                Codegen.AssignPromotionToChannelMutationVariables
            >(ASSIGN_PROMOTIONS_TO_CHANNEL, {
                input: {
                    promotionIds: Array.isArray(promotionId) ? promotionId : [promotionId],
                    channelId: taxIncludedChannel.id,
                },
            });
        }

        describe('orderPercentageDiscount', () => {
            const couponCode = '50%_off_order';
            let promotion: Codegen.PromotionFragment;

            beforeAll(async () => {
                promotion = await createPromotion({
                    enabled: true,
                    name: '20% discount on order',
                    couponCode,
                    conditions: [],
                    actions: [
                        {
                            code: orderPercentageDiscount.code,
                            arguments: [{ name: 'discount', value: '20' }],
                        },
                    ],
                });
                await assignPromotionToTaxIncludedChannel(promotion.id);
            });

            afterAll(async () => {
                await deletePromotion(promotion.id);
            });

            it('prices exclude tax', async () => {
                shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
                const { addItemToOrder } = await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-5000').id,
                    quantity: 1,
                });
                orderResultGuard.assertSuccess(addItemToOrder);
                expect(addItemToOrder.totalWithTax).toBe(6000);
                expect(addItemToOrder.discounts.length).toBe(0);

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode,
                });
                orderResultGuard.assertSuccess(applyCouponCode);
                expect(applyCouponCode.discounts.length).toBe(1);
                expect(applyCouponCode.discounts[0].description).toBe('20% discount on order');
                expect(applyCouponCode.totalWithTax).toBe(4800);
            });

            it('prices include tax', async () => {
                shopClient.setChannelToken(TAX_INCLUDED_CHANNEL_TOKEN);
                const { addItemToOrder } = await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-5000').id,
                    quantity: 1,
                });
                orderResultGuard.assertSuccess(addItemToOrder);
                expect(addItemToOrder.totalWithTax).toBe(6000);
                expect(addItemToOrder.discounts.length).toBe(0);

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode,
                });
                orderResultGuard.assertSuccess(applyCouponCode);
                expect(applyCouponCode.discounts.length).toBe(1);
                expect(applyCouponCode.discounts[0].description).toBe('20% discount on order');
                expect(applyCouponCode.totalWithTax).toBe(4800);
            });

            // https://github.com/vendure-ecommerce/vendure/issues/1773
            it('decimal percentage', async () => {
                const decimalPercentageCouponCode = 'DPCC';
                await createPromotion({
                    enabled: true,
                    name: '10.5% discount on order',
                    couponCode: decimalPercentageCouponCode,
                    conditions: [],
                    actions: [
                        {
                            code: orderPercentageDiscount.code,
                            arguments: [{ name: 'discount', value: '10.5' }],
                        },
                    ],
                });
                shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
                const { addItemToOrder } = await shopClient.query<
                    AddItemToOrder.Mutation,
                    AddItemToOrder.Variables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-5000').id,
                    quantity: 1,
                });
                orderResultGuard.assertSuccess(addItemToOrder);
                expect(addItemToOrder.totalWithTax).toBe(6000);
                expect(addItemToOrder.discounts.length).toBe(0);

                const { applyCouponCode } = await shopClient.query<
                    ApplyCouponCode.Mutation,
                    ApplyCouponCode.Variables
                >(APPLY_COUPON_CODE, {
                    couponCode: decimalPercentageCouponCode,
                });
                orderResultGuard.assertSuccess(applyCouponCode);
                expect(applyCouponCode.discounts.length).toBe(1);
                expect(applyCouponCode.discounts[0].description).toBe('10.5% discount on order');
                expect(applyCouponCode.totalWithTax).toBe(5370);
            });
        });

        describe('orderFixedDiscount', () => {
            const couponCode = '10_off_order';
            let promotion: Codegen.PromotionFragment;

            beforeAll(async () => {
                promotion = await createPromotion({
                    enabled: true,
                    name: '$10 discount on order',
                    couponCode,
                    conditions: [],
                    actions: [
                        {
                            code: orderFixedDiscount.code,
                            arguments: [{ name: 'discount', value: '1000' }],
                        },
                    ],
                });
                await assignPromotionToTaxIncludedChannel(promotion.id);
            });

            afterAll(async () => {
                await deletePromotion(promotion.id);
                shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            });

            it('prices exclude tax', async () => {
                shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
                const { addItemToOrder } = await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-5000').id,
                    quantity: 1,
                });
                orderResultGuard.assertSuccess(addItemToOrder);
                expect(addItemToOrder.total).toBe(5000);
                expect(addItemToOrder.totalWithTax).toBe(6000);
                expect(addItemToOrder.discounts.length).toBe(0);

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode,
                });
                orderResultGuard.assertSuccess(applyCouponCode);
                expect(applyCouponCode.discounts.length).toBe(1);
                expect(applyCouponCode.discounts[0].description).toBe('$10 discount on order');
                expect(applyCouponCode.total).toBe(4000);
                expect(applyCouponCode.totalWithTax).toBe(4800);
            });

            it('prices include tax', async () => {
                shopClient.setChannelToken(TAX_INCLUDED_CHANNEL_TOKEN);
                const { addItemToOrder } = await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-5000').id,
                    quantity: 1,
                });
                orderResultGuard.assertSuccess(addItemToOrder);
                expect(addItemToOrder.totalWithTax).toBe(6000);
                expect(addItemToOrder.discounts.length).toBe(0);

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode,
                });
                orderResultGuard.assertSuccess(applyCouponCode);
                expect(applyCouponCode.discounts.length).toBe(1);
                expect(applyCouponCode.discounts[0].description).toBe('$10 discount on order');
                expect(applyCouponCode.totalWithTax).toBe(5000);
            });

            it('does not result in negative total when shipping is included', async () => {
                shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
                const { addItemToOrder } = await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-100').id,
                    quantity: 1,
                });
                orderResultGuard.assertSuccess(addItemToOrder);
                expect(addItemToOrder.totalWithTax).toBe(120);
                expect(addItemToOrder.discounts.length).toBe(0);

                const { setOrderShippingMethod } = await shopClient.query<
                    CodegenShop.SetShippingMethodMutation,
                    CodegenShop.SetShippingMethodMutationVariables
                >(SET_SHIPPING_METHOD, {
                    id: 'T_1',
                });
                orderResultGuard.assertSuccess(setOrderShippingMethod);
                expect(setOrderShippingMethod.totalWithTax).toBe(620);

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode,
                });
                orderResultGuard.assertSuccess(applyCouponCode);
                expect(applyCouponCode.discounts.length).toBe(1);
                expect(applyCouponCode.discounts[0].description).toBe('$10 discount on order');
                expect(applyCouponCode.subTotalWithTax).toBe(0);
                expect(applyCouponCode.totalWithTax).toBe(500); // shipping price
            });
        });

        describe('orderLineFixedDiscount', () => {
            const couponCode = '1000_off_order_line';
            let promotion: Codegen.PromotionFragment;

            beforeAll(async () => {
                promotion = await createPromotion({
                    enabled: true,
                    name: '$1000 discount on order line',
                    couponCode,
                    conditions: [],
                    actions: [
                        {
                            code: orderLineFixedDiscount.code,
                            arguments: [{ name: 'discount', value: '1000' }],
                        },
                    ],
                });
            });

            afterAll(async () => {
                await deletePromotion(promotion.id);
            });

            it('prices exclude tax', async () => {
                await shopClient.asAnonymousUser();
                const { addItemToOrder } = await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-1000').id,
                    quantity: 3,
                });
                orderResultGuard.assertSuccess(addItemToOrder);
                expect(addItemToOrder.discounts.length).toBe(0);
                expect(addItemToOrder.lines[0].discounts.length).toBe(0);
                expect(addItemToOrder.total).toBe(3000);
                expect(addItemToOrder.totalWithTax).toBe(3600);

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode,
                });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.total).toBe(2000);
                expect(applyCouponCode.totalWithTax).toBe(2400);
                expect(applyCouponCode.lines[0].discounts.length).toBe(1);
            });
        });

        describe('discountOnItemWithFacets', () => {
            const couponCode = '50%_off_sale_items';
            let promotion: Codegen.PromotionFragment;

            function getItemSale1Line<
                T extends Array<
                    | CodegenShop.UpdatedOrderFragment['lines'][number]
                    | CodegenShop.TestOrderFragmentFragment['lines'][number]
                >,
            >(lines: T): T[number] {
                return lines.find(l => l.productVariant.id === getVariantBySlug('item-sale-100').id)!;
            }

            beforeAll(async () => {
                const { facets } = await adminClient.query<Codegen.GetFacetListQuery>(GET_FACET_LIST);
                const saleFacetValue = facets.items[0].values[0];
                promotion = await createPromotion({
                    enabled: true,
                    name: '50% off sale items',
                    couponCode,
                    conditions: [],
                    actions: [
                        {
                            code: discountOnItemWithFacets.code,
                            arguments: [
                                { name: 'discount', value: '50' },
                                { name: 'facets', value: `["${saleFacetValue.id}"]` },
                            ],
                        },
                    ],
                });
                await assignPromotionToTaxIncludedChannel(promotion.id);
            });

            afterAll(async () => {
                await deletePromotion(promotion.id);
                shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            });

            it('prices exclude tax', async () => {
                await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-1000').id,
                    quantity: 1,
                });
                await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-sale-1000').id,
                    quantity: 1,
                });
                const { addItemToOrder } = await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-sale-100').id,
                    quantity: 2,
                });

                orderResultGuard.assertSuccess(addItemToOrder);
                expect(addItemToOrder.discounts.length).toBe(0);
                expect(getItemSale1Line(addItemToOrder.lines).discounts.length).toBe(0);
                expect(addItemToOrder.total).toBe(2200);
                expect(addItemToOrder.totalWithTax).toBe(2640);

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode,
                });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.total).toBe(1600);
                expect(applyCouponCode.totalWithTax).toBe(1920);
                expect(getItemSale1Line(applyCouponCode.lines).discounts.length).toBe(1); // 1x promotion

                const { removeCouponCode } = await shopClient.query<
                    CodegenShop.RemoveCouponCodeMutation,
                    CodegenShop.RemoveCouponCodeMutationVariables
                >(REMOVE_COUPON_CODE, {
                    couponCode,
                });

                expect(getItemSale1Line(removeCouponCode!.lines).discounts.length).toBe(0);
                expect(removeCouponCode!.total).toBe(2200);
                expect(removeCouponCode!.totalWithTax).toBe(2640);

                const { activeOrder } =
                    await shopClient.query<CodegenShop.GetActiveOrderQuery>(GET_ACTIVE_ORDER);
                expect(getItemSale1Line(activeOrder!.lines).discounts.length).toBe(0);
                expect(activeOrder!.total).toBe(2200);
                expect(activeOrder!.totalWithTax).toBe(2640);
            });

            it('prices include tax', async () => {
                shopClient.setChannelToken(TAX_INCLUDED_CHANNEL_TOKEN);
                await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-1000').id,
                    quantity: 1,
                });
                await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-sale-1000').id,
                    quantity: 1,
                });
                const { addItemToOrder } = await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-sale-100').id,
                    quantity: 2,
                });

                orderResultGuard.assertSuccess(addItemToOrder);
                expect(addItemToOrder.discounts.length).toBe(0);
                expect(getItemSale1Line(addItemToOrder.lines).discounts.length).toBe(0);
                expect(addItemToOrder.total).toBe(2200);
                expect(addItemToOrder.totalWithTax).toBe(2640);

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode,
                });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.total).toBe(1600);
                expect(applyCouponCode.totalWithTax).toBe(1920);
                expect(getItemSale1Line(applyCouponCode.lines).discounts.length).toBe(1); // 1x promotion

                const { removeCouponCode } = await shopClient.query<
                    CodegenShop.RemoveCouponCodeMutation,
                    CodegenShop.RemoveCouponCodeMutationVariables
                >(REMOVE_COUPON_CODE, {
                    couponCode,
                });

                expect(getItemSale1Line(removeCouponCode!.lines).discounts.length).toBe(0);
                expect(removeCouponCode!.total).toBe(2200);
                expect(removeCouponCode!.totalWithTax).toBe(2640);

                const { activeOrder } =
                    await shopClient.query<CodegenShop.GetActiveOrderQuery>(GET_ACTIVE_ORDER);
                expect(getItemSale1Line(activeOrder!.lines).discounts.length).toBe(0);
                expect(activeOrder!.total).toBe(2200);
                expect(activeOrder!.totalWithTax).toBe(2640);
            });
        });

        describe('productsPercentageDiscount', () => {
            const couponCode = '50%_off_product';
            let promotion: Codegen.PromotionFragment;

            beforeAll(async () => {
                promotion = await createPromotion({
                    enabled: true,
                    name: '50% off product',
                    couponCode,
                    conditions: [],
                    actions: [
                        {
                            code: productsPercentageDiscount.code,
                            arguments: [
                                { name: 'discount', value: '50' },
                                {
                                    name: 'productVariantIds',
                                    value: `["${getVariantBySlug('item-5000').id}"]`,
                                },
                            ],
                        },
                    ],
                });
                await assignPromotionToTaxIncludedChannel(promotion.id);
            });

            afterAll(async () => {
                await deletePromotion(promotion.id);
                shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            });

            it('prices exclude tax', async () => {
                const { addItemToOrder } = await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-5000').id,
                    quantity: 1,
                });
                orderResultGuard.assertSuccess(addItemToOrder);
                expect(addItemToOrder.discounts.length).toBe(0);
                expect(addItemToOrder.lines[0].discounts.length).toBe(0);
                expect(addItemToOrder.total).toBe(5000);
                expect(addItemToOrder.totalWithTax).toBe(6000);

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode,
                });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.total).toBe(2500);
                expect(applyCouponCode.totalWithTax).toBe(3000);
                expect(applyCouponCode.lines[0].discounts.length).toBe(1); // 1x promotion
            });

            it('prices include tax', async () => {
                shopClient.setChannelToken(TAX_INCLUDED_CHANNEL_TOKEN);
                const { addItemToOrder } = await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-5000').id,
                    quantity: 1,
                });
                orderResultGuard.assertSuccess(addItemToOrder);
                expect(addItemToOrder.discounts.length).toBe(0);
                expect(addItemToOrder.lines[0].discounts.length).toBe(0);
                expect(addItemToOrder.total).toBe(5000);
                expect(addItemToOrder.totalWithTax).toBe(6000);

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode,
                });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.total).toBe(2500);
                expect(applyCouponCode.totalWithTax).toBe(3000);
                expect(applyCouponCode.lines[0].discounts.length).toBe(1); // 1x promotion
            });
        });

        describe('freeShipping', () => {
            const couponCode = 'FREE_SHIPPING';
            let promotion: Codegen.PromotionFragment;

            // The test shipping method needs to be created in each Channel, since ShippingMethods
            // are ChannelAware
            async function createTestShippingMethod(channelToken: string) {
                adminClient.setChannelToken(channelToken);
                const result = await adminClient.query<
                    Codegen.CreateShippingMethodMutation,
                    Codegen.CreateShippingMethodMutationVariables
                >(CREATE_SHIPPING_METHOD, {
                    input: {
                        code: 'test-method',
                        fulfillmentHandler: manualFulfillmentHandler.code,
                        checker: {
                            code: defaultShippingEligibilityChecker.code,
                            arguments: [
                                {
                                    name: 'orderMinimum',
                                    value: '0',
                                },
                            ],
                        },
                        calculator: {
                            code: defaultShippingCalculator.code,
                            arguments: [
                                { name: 'rate', value: '345' },
                                { name: 'includesTax', value: 'auto' },
                                { name: 'taxRate', value: '20' },
                            ],
                        },
                        translations: [
                            { languageCode: LanguageCode.en, name: 'test method', description: '' },
                        ],
                    },
                });
                adminClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
                return result.createShippingMethod;
            }

            beforeAll(async () => {
                promotion = await createPromotion({
                    enabled: true,
                    name: 'Free shipping',
                    couponCode,
                    conditions: [],
                    actions: [
                        {
                            code: freeShipping.code,
                            arguments: [],
                        },
                    ],
                });
                await assignPromotionToTaxIncludedChannel(promotion.id);
            });

            afterAll(async () => {
                await deletePromotion(promotion.id);
                shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            });

            it('prices exclude tax', async () => {
                const { addItemToOrder } = await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-5000').id,
                    quantity: 1,
                });
                const method = await createTestShippingMethod(E2E_DEFAULT_CHANNEL_TOKEN);
                const { setOrderShippingMethod } = await shopClient.query<
                    CodegenShop.SetShippingMethodMutation,
                    CodegenShop.SetShippingMethodMutationVariables
                >(SET_SHIPPING_METHOD, {
                    id: method.id,
                });
                orderResultGuard.assertSuccess(setOrderShippingMethod);
                expect(setOrderShippingMethod.discounts).toEqual([]);
                expect(setOrderShippingMethod.shipping).toBe(345);
                expect(setOrderShippingMethod.shippingWithTax).toBe(414);
                expect(setOrderShippingMethod.total).toBe(5345);
                expect(setOrderShippingMethod.totalWithTax).toBe(6414);

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode,
                });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.discounts.length).toBe(1);
                expect(applyCouponCode.discounts[0].description).toBe('Free shipping');
                expect(applyCouponCode.shipping).toBe(0);
                expect(applyCouponCode.shippingWithTax).toBe(0);
                expect(applyCouponCode.total).toBe(5000);
                expect(applyCouponCode.totalWithTax).toBe(6000);
            });

            it('prices include tax', async () => {
                shopClient.setChannelToken(TAX_INCLUDED_CHANNEL_TOKEN);
                const { addItemToOrder } = await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-5000').id,
                    quantity: 1,
                });
                const method = await createTestShippingMethod(TAX_INCLUDED_CHANNEL_TOKEN);
                const { setOrderShippingMethod } = await shopClient.query<
                    CodegenShop.SetShippingMethodMutation,
                    CodegenShop.SetShippingMethodMutationVariables
                >(SET_SHIPPING_METHOD, {
                    id: method.id,
                });
                orderResultGuard.assertSuccess(setOrderShippingMethod);
                expect(setOrderShippingMethod.discounts).toEqual([]);
                expect(setOrderShippingMethod.shipping).toBe(288);
                expect(setOrderShippingMethod.shippingWithTax).toBe(345);
                expect(setOrderShippingMethod.total).toBe(5288);
                expect(setOrderShippingMethod.totalWithTax).toBe(6345);

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode,
                });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.discounts.length).toBe(1);
                expect(applyCouponCode.discounts[0].description).toBe('Free shipping');
                expect(applyCouponCode.shipping).toBe(0);
                expect(applyCouponCode.shippingWithTax).toBe(0);
                expect(applyCouponCode.total).toBe(5000);
                expect(applyCouponCode.totalWithTax).toBe(6000);
            });

            // https://github.com/vendure-ecommerce/vendure/pull/1150
            it('shipping discounts get correctly removed', async () => {
                shopClient.setChannelToken(TAX_INCLUDED_CHANNEL_TOKEN);
                const { addItemToOrder } = await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-5000').id,
                    quantity: 1,
                });
                const method = await createTestShippingMethod(TAX_INCLUDED_CHANNEL_TOKEN);
                const { setOrderShippingMethod } = await shopClient.query<
                    CodegenShop.SetShippingMethodMutation,
                    CodegenShop.SetShippingMethodMutationVariables
                >(SET_SHIPPING_METHOD, {
                    id: method.id,
                });
                orderResultGuard.assertSuccess(setOrderShippingMethod);
                expect(setOrderShippingMethod.discounts).toEqual([]);
                expect(setOrderShippingMethod.shippingWithTax).toBe(345);

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode,
                });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.discounts.length).toBe(1);
                expect(applyCouponCode.discounts[0].description).toBe('Free shipping');
                expect(applyCouponCode.shippingWithTax).toBe(0);

                const { removeCouponCode } = await shopClient.query<
                    CodegenShop.RemoveCouponCodeMutation,
                    CodegenShop.RemoveCouponCodeMutationVariables
                >(REMOVE_COUPON_CODE, {
                    couponCode,
                });

                orderResultGuard.assertSuccess(removeCouponCode);
                expect(removeCouponCode.discounts).toEqual([]);
                expect(removeCouponCode.shippingWithTax).toBe(345);
            });
        });

        describe('multiple promotions simultaneously', () => {
            const saleItem50pcOffCoupon = 'CODE1';
            const order15pcOffCoupon = 'CODE2';
            let promotion1: Codegen.PromotionFragment;
            let promotion2: Codegen.PromotionFragment;

            beforeAll(async () => {
                const { facets } = await adminClient.query<Codegen.GetFacetListQuery>(GET_FACET_LIST);
                const saleFacetValue = facets.items[0].values[0];
                promotion1 = await createPromotion({
                    enabled: true,
                    name: 'item promo',
                    couponCode: saleItem50pcOffCoupon,
                    conditions: [],
                    actions: [
                        {
                            code: discountOnItemWithFacets.code,
                            arguments: [
                                { name: 'discount', value: '50' },
                                { name: 'facets', value: `["${saleFacetValue.id}"]` },
                            ],
                        },
                    ],
                });
                promotion2 = await createPromotion({
                    enabled: true,
                    name: 'order promo',
                    couponCode: order15pcOffCoupon,
                    conditions: [],
                    actions: [
                        {
                            code: orderPercentageDiscount.code,
                            arguments: [{ name: 'discount', value: '15' }],
                        },
                    ],
                });
                await assignPromotionToTaxIncludedChannel([promotion1.id, promotion2.id]);
            });

            afterAll(async () => {
                await deletePromotion(promotion1.id);
                await deletePromotion(promotion2.id);
                shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            });

            it('prices exclude tax', async () => {
                await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-sale-1000').id,
                    quantity: 2,
                });
                await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-5000').id,
                    quantity: 1,
                });

                // Apply the OrderItem-level promo
                const { applyCouponCode: apply1 } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode: saleItem50pcOffCoupon,
                });
                orderResultGuard.assertSuccess(apply1);
                const saleItemLine = apply1.lines.find(
                    l => l.productVariant.id === getVariantBySlug('item-sale-1000').id,
                )!;
                expect(saleItemLine.discounts.length).toBe(1); // 1x promotion
                expect(
                    saleItemLine.discounts.find(a => a.type === AdjustmentType.PROMOTION)?.description,
                ).toBe('item promo');
                expect(apply1.discounts.length).toBe(1);
                expect(apply1.total).toBe(6000);
                expect(apply1.totalWithTax).toBe(7200);

                // Apply the Order-level promo
                const { applyCouponCode: apply2 } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode: order15pcOffCoupon,
                });
                orderResultGuard.assertSuccess(apply2);

                expect(apply2.discounts.map(d => d.description).sort()).toEqual([
                    'item promo',
                    'order promo',
                ]);
                expect(apply2.total).toBe(5100);
                expect(apply2.totalWithTax).toBe(6120);
            });

            it('prices include tax', async () => {
                shopClient.setChannelToken(TAX_INCLUDED_CHANNEL_TOKEN);
                await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-sale-1000').id,
                    quantity: 2,
                });
                await shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: getVariantBySlug('item-5000').id,
                    quantity: 1,
                });

                // Apply the OrderItem-level promo
                const { applyCouponCode: apply1 } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode: saleItem50pcOffCoupon,
                });
                orderResultGuard.assertSuccess(apply1);
                const saleItemLine = apply1.lines.find(
                    l => l.productVariant.id === getVariantBySlug('item-sale-1000').id,
                )!;
                expect(saleItemLine.discounts.length).toBe(1); // 1x promotion
                expect(
                    saleItemLine.discounts.find(a => a.type === AdjustmentType.PROMOTION)?.description,
                ).toBe('item promo');
                expect(apply1.discounts.length).toBe(1);
                expect(apply1.total).toBe(6000);
                expect(apply1.totalWithTax).toBe(7200);

                // Apply the Order-level promo
                const { applyCouponCode: apply2 } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, {
                    couponCode: order15pcOffCoupon,
                });
                orderResultGuard.assertSuccess(apply2);

                expect(apply2.discounts.map(d => d.description).sort()).toEqual([
                    'item promo',
                    'order promo',
                ]);
                expect(apply2.total).toBe(5100);
                expect(apply2.totalWithTax).toBe(6120);
            });
        });
    });

    describe('per-customer usage limit', () => {
        const TEST_COUPON_CODE = 'TESTCOUPON';
        const orderGuard: ErrorResultGuard<CodegenShop.TestOrderWithPaymentsFragment> =
            createErrorResultGuard(input => !!input.lines);
        let promoWithUsageLimit: Codegen.PromotionFragment;

        beforeAll(async () => {
            promoWithUsageLimit = await createPromotion({
                enabled: true,
                name: 'Free with test coupon',
                couponCode: TEST_COUPON_CODE,
                perCustomerUsageLimit: 1,
                conditions: [],
                actions: [freeOrderAction],
            });
        });

        afterAll(async () => {
            await deletePromotion(promoWithUsageLimit.id);
        });

        async function createNewActiveOrder() {
            const { addItemToOrder } = await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: getVariantBySlug('item-5000').id,
                quantity: 1,
            });
            return addItemToOrder;
        }

        describe('guest customer', () => {
            const GUEST_EMAIL_ADDRESS = 'guest@test.com';
            let orderCode: string;

            function addGuestCustomerToOrder() {
                return shopClient.query<
                    CodegenShop.SetCustomerForOrderMutation,
                    CodegenShop.SetCustomerForOrderMutationVariables
                >(SET_CUSTOMER, {
                    input: {
                        emailAddress: GUEST_EMAIL_ADDRESS,
                        firstName: 'Guest',
                        lastName: 'Customer',
                    },
                });
            }

            it('allows initial usage', async () => {
                await shopClient.asAnonymousUser();
                await createNewActiveOrder();
                await addGuestCustomerToOrder();

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, { couponCode: TEST_COUPON_CODE });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.totalWithTax).toBe(0);
                expect(applyCouponCode.couponCodes).toEqual([TEST_COUPON_CODE]);

                await proceedToArrangingPayment(shopClient);
                const order = await addPaymentToOrder(shopClient, testSuccessfulPaymentMethod);
                orderGuard.assertSuccess(order);

                expect(order.state).toBe('PaymentSettled');
                expect(order.active).toBe(false);
                orderCode = order.code;
            });

            it('adds Promotions to Order once payment arranged', async () => {
                const { orderByCode } = await shopClient.query<
                    CodegenShop.GetOrderPromotionsByCodeQuery,
                    CodegenShop.GetOrderPromotionsByCodeQueryVariables
                >(GET_ORDER_PROMOTIONS_BY_CODE, {
                    code: orderCode,
                });
                expect(orderByCode!.promotions.map(pick(['name']))).toEqual([
                    { name: 'Free with test coupon' },
                ]);
            });

            it('returns error result when usage exceeds limit', async () => {
                await shopClient.asAnonymousUser();
                await createNewActiveOrder();
                await addGuestCustomerToOrder();

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, { couponCode: TEST_COUPON_CODE });
                orderResultGuard.assertErrorResult(applyCouponCode);

                expect(applyCouponCode.message).toEqual(
                    'Coupon code cannot be used more than once per customer',
                );
            });

            it('removes couponCode from order when adding customer after code applied', async () => {
                await shopClient.asAnonymousUser();
                await createNewActiveOrder();

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, { couponCode: TEST_COUPON_CODE });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.totalWithTax).toBe(0);
                expect(applyCouponCode.couponCodes).toEqual([TEST_COUPON_CODE]);

                await addGuestCustomerToOrder();

                const { activeOrder } =
                    await shopClient.query<CodegenShop.GetActiveOrderQuery>(GET_ACTIVE_ORDER);
                expect(activeOrder!.couponCodes).toEqual([]);
                expect(activeOrder!.totalWithTax).toBe(6000);
            });

            it('does not remove valid couponCode when setting guest customer', async () => {
                await shopClient.asAnonymousUser();
                await createNewActiveOrder();

                const { applyCouponCode } = await shopClient.query<
                    ApplyCouponCode.Mutation,
                    ApplyCouponCode.Variables
                >(APPLY_COUPON_CODE, { couponCode: TEST_COUPON_CODE });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.totalWithTax).toBe(0);
                expect(applyCouponCode.couponCodes).toEqual([TEST_COUPON_CODE]);

                await shopClient.query<SetCustomerForOrder.Mutation, SetCustomerForOrder.Variables>(
                    SET_CUSTOMER,
                    {
                        input: {
                            emailAddress: 'new-guest@test.com',
                            firstName: 'New Guest',
                            lastName: 'Customer',
                        },
                    },
                );

                const { activeOrder } = await shopClient.query<GetActiveOrder.Query>(GET_ACTIVE_ORDER);
                expect(activeOrder.couponCodes).toEqual([TEST_COUPON_CODE]);
                expect(applyCouponCode.totalWithTax).toBe(0);
            });
        });

        describe('signed-in customer', () => {
            function logInAsRegisteredCustomer() {
                return shopClient.asUserWithCredentials('hayden.zieme12@hotmail.com', 'test');
            }

            let orderId: string;

            it('allows initial usage', async () => {
                await logInAsRegisteredCustomer();
                await createNewActiveOrder();
                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, { couponCode: TEST_COUPON_CODE });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.totalWithTax).toBe(0);
                expect(applyCouponCode.couponCodes).toEqual([TEST_COUPON_CODE]);

                await proceedToArrangingPayment(shopClient);
                const order = await addPaymentToOrder(shopClient, testSuccessfulPaymentMethod);
                orderGuard.assertSuccess(order);
                orderId = order.id;

                expect(order.state).toBe('PaymentSettled');
                expect(order.active).toBe(false);
            });

            it('returns error result when usage exceeds limit', async () => {
                await logInAsRegisteredCustomer();
                await createNewActiveOrder();
                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, { couponCode: TEST_COUPON_CODE });
                orderResultGuard.assertErrorResult(applyCouponCode);
                expect(applyCouponCode.message).toEqual(
                    'Coupon code cannot be used more than once per customer',
                );
                expect(applyCouponCode.errorCode).toBe(ErrorCode.COUPON_CODE_LIMIT_ERROR);
            });

            it('removes couponCode from order when logging in after code applied', async () => {
                await shopClient.asAnonymousUser();
                await createNewActiveOrder();
                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, { couponCode: TEST_COUPON_CODE });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.couponCodes).toEqual([TEST_COUPON_CODE]);
                expect(applyCouponCode.totalWithTax).toBe(0);

                await logInAsRegisteredCustomer();

                const { activeOrder } =
                    await shopClient.query<CodegenShop.GetActiveOrderQuery>(GET_ACTIVE_ORDER);
                expect(activeOrder!.totalWithTax).toBe(6000);
                expect(activeOrder!.couponCodes).toEqual([]);
            });

            // https://github.com/vendure-ecommerce/vendure/issues/1466
            it('cancelled orders do not count against usage limit', async () => {
                const { cancelOrder } = await adminClient.query<
                    Codegen.CancelOrderMutation,
                    Codegen.CancelOrderMutationVariables
                >(CANCEL_ORDER, {
                    input: {
                        orderId,
                        cancelShipping: true,
                        reason: 'request',
                    },
                });
                orderResultGuard.assertSuccess(cancelOrder);
                expect(cancelOrder.state).toBe('Cancelled');

                await logInAsRegisteredCustomer();
                await createNewActiveOrder();
                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, { couponCode: TEST_COUPON_CODE });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.totalWithTax).toBe(0);
                expect(applyCouponCode.couponCodes).toEqual([TEST_COUPON_CODE]);
            });
        });
    });

    describe('usage limit', () => {
        const TEST_COUPON_CODE = 'TESTCOUPON';
        const orderGuard: ErrorResultGuard<CodegenShop.TestOrderWithPaymentsFragment> =
            createErrorResultGuard(input => !!input.lines);
        let promoWithUsageLimit: Codegen.PromotionFragment;

        async function createNewActiveOrder() {
            const { addItemToOrder } = await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: getVariantBySlug('item-5000').id,
                quantity: 1,
            });
            return addItemToOrder;
        }

        describe('guest customer', () => {
            const GUEST_EMAIL_ADDRESS = 'guest@test.com';
            let orderCode: string;

            beforeAll(async () => {
                promoWithUsageLimit = await createPromotion({
                    enabled: true,
                    name: 'Free with test coupon',
                    couponCode: TEST_COUPON_CODE,
                    usageLimit: 1,
                    conditions: [],
                    actions: [freeOrderAction],
                });
            });

            afterAll(async () => {
                await deletePromotion(promoWithUsageLimit.id);
            });

            function addGuestCustomerToOrder() {
                return shopClient.query<
                    CodegenShop.SetCustomerForOrderMutation,
                    CodegenShop.SetCustomerForOrderMutationVariables
                >(SET_CUSTOMER, {
                    input: {
                        emailAddress: GUEST_EMAIL_ADDRESS,
                        firstName: 'Guest',
                        lastName: 'Customer',
                    },
                });
            }

            it('allows initial usage', async () => {
                await shopClient.asAnonymousUser();
                await createNewActiveOrder();
                await addGuestCustomerToOrder();

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, { couponCode: TEST_COUPON_CODE });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.totalWithTax).toBe(0);
                expect(applyCouponCode.couponCodes).toEqual([TEST_COUPON_CODE]);

                await proceedToArrangingPayment(shopClient);
                const order = await addPaymentToOrder(shopClient, testSuccessfulPaymentMethod);
                orderGuard.assertSuccess(order);

                expect(order.state).toBe('PaymentSettled');
                expect(order.active).toBe(false);
                orderCode = order.code;
            });

            it('adds Promotions to Order once payment arranged', async () => {
                const { orderByCode } = await shopClient.query<
                    CodegenShop.GetOrderPromotionsByCodeQuery,
                    CodegenShop.GetOrderPromotionsByCodeQueryVariables
                >(GET_ORDER_PROMOTIONS_BY_CODE, {
                    code: orderCode,
                });
                expect(orderByCode!.promotions.map(pick(['name']))).toEqual([
                    { name: 'Free with test coupon' },
                ]);
            });

            it('returns error result when usage exceeds limit', async () => {
                await shopClient.asAnonymousUser();
                await createNewActiveOrder();
                await addGuestCustomerToOrder();

                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, { couponCode: TEST_COUPON_CODE });
                orderResultGuard.assertErrorResult(applyCouponCode);

                expect(applyCouponCode.message).toEqual(
                    'Coupon code cannot be used more than once per customer',
                );
            });
        });

        describe('signed-in customer', () => {
            beforeAll(async () => {
                promoWithUsageLimit = await createPromotion({
                    enabled: true,
                    name: 'Free with test coupon',
                    couponCode: TEST_COUPON_CODE,
                    usageLimit: 1,
                    conditions: [],
                    actions: [freeOrderAction],
                });
            });

            afterAll(async () => {
                await deletePromotion(promoWithUsageLimit.id);
            });

            function logInAsRegisteredCustomer() {
                return shopClient.asUserWithCredentials('hayden.zieme12@hotmail.com', 'test');
            }

            let orderId: string;

            it('allows initial usage', async () => {
                await logInAsRegisteredCustomer();
                await createNewActiveOrder();
                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, { couponCode: TEST_COUPON_CODE });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.totalWithTax).toBe(0);
                expect(applyCouponCode.couponCodes).toEqual([TEST_COUPON_CODE]);

                await proceedToArrangingPayment(shopClient);
                const order = await addPaymentToOrder(shopClient, testSuccessfulPaymentMethod);
                orderGuard.assertSuccess(order);
                orderId = order.id;

                expect(order.state).toBe('PaymentSettled');
                expect(order.active).toBe(false);
            });

            it('returns error result when usage exceeds limit', async () => {
                await logInAsRegisteredCustomer();
                await createNewActiveOrder();
                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, { couponCode: TEST_COUPON_CODE });
                orderResultGuard.assertErrorResult(applyCouponCode);
                expect(applyCouponCode.message).toEqual(
                    'Coupon code cannot be used more than once per customer',
                );
                expect(applyCouponCode.errorCode).toBe(ErrorCode.COUPON_CODE_LIMIT_ERROR);
            });

            // https://github.com/vendure-ecommerce/vendure/issues/1466
            it('cancelled orders do not count against usage limit', async () => {
                const { cancelOrder } = await adminClient.query<
                    Codegen.CancelOrderMutation,
                    Codegen.CancelOrderMutationVariables
                >(CANCEL_ORDER, {
                    input: {
                        orderId,
                        cancelShipping: true,
                        reason: 'request',
                    },
                });
                orderResultGuard.assertSuccess(cancelOrder);
                expect(cancelOrder.state).toBe('Cancelled');

                await logInAsRegisteredCustomer();
                await createNewActiveOrder();
                const { applyCouponCode } = await shopClient.query<
                    CodegenShop.ApplyCouponCodeMutation,
                    CodegenShop.ApplyCouponCodeMutationVariables
                >(APPLY_COUPON_CODE, { couponCode: TEST_COUPON_CODE });
                orderResultGuard.assertSuccess(applyCouponCode);

                expect(applyCouponCode.totalWithTax).toBe(0);
                expect(applyCouponCode.couponCodes).toEqual([TEST_COUPON_CODE]);
            });
        });
    });

    // https://github.com/vendure-ecommerce/vendure/issues/710
    it('removes order-level discount made invalid by removing OrderLine', async () => {
        const promotion = await createPromotion({
            enabled: true,
            name: 'Test Promo',
            conditions: [minOrderAmountCondition(10000)],
            actions: [
                {
                    code: orderFixedDiscount.code,
                    arguments: [{ name: 'discount', value: '1000' }],
                },
            ],
        });

        await shopClient.asAnonymousUser();
        await shopClient.query<
            CodegenShop.AddItemToOrderMutation,
            CodegenShop.AddItemToOrderMutationVariables
        >(ADD_ITEM_TO_ORDER, {
            productVariantId: getVariantBySlug('item-1000').id,
            quantity: 8,
        });
        const { addItemToOrder } = await shopClient.query<
            CodegenShop.AddItemToOrderMutation,
            CodegenShop.AddItemToOrderMutationVariables
        >(ADD_ITEM_TO_ORDER, {
            productVariantId: getVariantBySlug('item-5000').id,
            quantity: 1,
        });
        orderResultGuard.assertSuccess(addItemToOrder);
        expect(addItemToOrder.discounts.length).toBe(1);
        expect(addItemToOrder.discounts[0].description).toBe('Test Promo');

        const { activeOrder: check1 } =
            await shopClient.query<CodegenShop.GetActiveOrderQuery>(GET_ACTIVE_ORDER);
        expect(check1!.discounts.length).toBe(1);
        expect(check1!.discounts[0].description).toBe('Test Promo');

        const { removeOrderLine } = await shopClient.query<
            CodegenShop.RemoveItemFromOrderMutation,
            CodegenShop.RemoveItemFromOrderMutationVariables
        >(REMOVE_ITEM_FROM_ORDER, {
            orderLineId: addItemToOrder.lines[1].id,
        });

        orderResultGuard.assertSuccess(removeOrderLine);
        expect(removeOrderLine.discounts.length).toBe(0);

        const { activeOrder: check2 } =
            await shopClient.query<CodegenShop.GetActiveOrderQuery>(GET_ACTIVE_ORDER);
        expect(check2!.discounts.length).toBe(0);
    });

    // https://github.com/vendure-ecommerce/vendure/issues/1492
    it('correctly handles pro-ration of variants with 0 price', async () => {
        const couponCode = '20%_off_order';
        const promotion = await createPromotion({
            enabled: true,
            name: '20% discount on order',
            couponCode,
            conditions: [],
            actions: [
                {
                    code: orderPercentageDiscount.code,
                    arguments: [{ name: 'discount', value: '20' }],
                },
            ],
        });
        await shopClient.asAnonymousUser();
        await shopClient.query<
            CodegenShop.AddItemToOrderMutation,
            CodegenShop.AddItemToOrderMutationVariables
        >(ADD_ITEM_TO_ORDER, {
            productVariantId: getVariantBySlug('item-100').id,
            quantity: 1,
        });
        await shopClient.query<
            CodegenShop.AddItemToOrderMutation,
            CodegenShop.AddItemToOrderMutationVariables
        >(ADD_ITEM_TO_ORDER, {
            productVariantId: getVariantBySlug('item-0').id,
            quantity: 1,
        });
        const { applyCouponCode } = await shopClient.query<
            CodegenShop.ApplyCouponCodeMutation,
            CodegenShop.ApplyCouponCodeMutationVariables
        >(APPLY_COUPON_CODE, { couponCode });
        orderResultGuard.assertSuccess(applyCouponCode);
        expect(applyCouponCode.totalWithTax).toBe(96);
    });

    // https://github.com/vendure-ecommerce/vendure/issues/2385
    describe('prevents negative line price', () => {
        const TAX_INCLUDED_CHANNEL_TOKEN_2 = 'tax_included_channel_2';
        const couponCode1 = '100%_off';
        const couponCode2 = '100%_off';
        let taxIncludedChannel: Codegen.ChannelFragment;

        beforeAll(async () => {
            // Create a channel where the prices include tax, so we can ensure
            // that PromotionActions are working as expected when taxes are included
            const { createChannel } = await adminClient.query<
                Codegen.CreateChannelMutation,
                Codegen.CreateChannelMutationVariables
            >(CREATE_CHANNEL, {
                input: {
                    code: 'tax-included-channel-2',
                    currencyCode: CurrencyCode.GBP,
                    pricesIncludeTax: true,
                    defaultTaxZoneId: 'T_1',
                    defaultShippingZoneId: 'T_1',
                    defaultLanguageCode: LanguageCode.en,
                    token: TAX_INCLUDED_CHANNEL_TOKEN_2,
                },
            });
            taxIncludedChannel = createChannel as Codegen.ChannelFragment;
            await adminClient.query<
                Codegen.AssignProductsToChannelMutation,
                Codegen.AssignProductsToChannelMutationVariables
            >(ASSIGN_PRODUCT_TO_CHANNEL, {
                input: {
                    channelId: taxIncludedChannel.id,
                    priceFactor: 1,
                    productIds: products.map(p => p.id),
                },
            });
            const item1000 = getVariantBySlug('item-1000')!;
            const promo100 = await createPromotion({
                enabled: true,
                name: '100% discount ',
                couponCode: couponCode1,
                conditions: [],
                actions: [
                    {
                        code: productsPercentageDiscount.code,
                        arguments: [
                            { name: 'discount', value: '100' },
                            {
                                name: 'productVariantIds',
                                value: `["${item1000.id}"]`,
                            },
                        ],
                    },
                ],
            });
            const promo20 = await createPromotion({
                enabled: true,
                name: '20% discount ',
                couponCode: couponCode2,
                conditions: [],
                actions: [
                    {
                        code: productsPercentageDiscount.code,
                        arguments: [
                            { name: 'discount', value: '20' },
                            {
                                name: 'productVariantIds',
                                value: `["${item1000.id}"]`,
                            },
                        ],
                    },
                ],
            });
            await adminClient.query<
                Codegen.AssignPromotionToChannelMutation,
                Codegen.AssignPromotionToChannelMutationVariables
            >(ASSIGN_PROMOTIONS_TO_CHANNEL, {
                input: {
                    promotionIds: [promo100.id, promo20.id],
                    channelId: taxIncludedChannel.id,
                },
            });
        });

        it('prices exclude tax', async () => {
            await shopClient.asAnonymousUser();
            const item1000 = getVariantBySlug('item-1000')!;

            await shopClient.query<
                CodegenShop.ApplyCouponCodeMutation,
                CodegenShop.ApplyCouponCodeMutationVariables
            >(APPLY_COUPON_CODE, { couponCode: couponCode1 });

            await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: item1000.id,
                quantity: 1,
            });

            const { activeOrder: check1 } =
                await shopClient.query<CodegenShop.GetActiveOrderQuery>(GET_ACTIVE_ORDER);

            expect(check1!.lines[0].discountedUnitPriceWithTax).toBe(0);
            expect(check1!.totalWithTax).toBe(0);

            await shopClient.query<
                CodegenShop.ApplyCouponCodeMutation,
                CodegenShop.ApplyCouponCodeMutationVariables
            >(APPLY_COUPON_CODE, { couponCode: couponCode2 });

            const { activeOrder: check2 } =
                await shopClient.query<CodegenShop.GetActiveOrderQuery>(GET_ACTIVE_ORDER);
            expect(check2!.lines[0].discountedUnitPriceWithTax).toBe(0);
            expect(check2!.totalWithTax).toBe(0);
        });

        it('prices include tax', async () => {
            shopClient.setChannelToken(TAX_INCLUDED_CHANNEL_TOKEN_2);
            await shopClient.asAnonymousUser();
            const item1000 = getVariantBySlug('item-1000')!;

            await shopClient.query<
                CodegenShop.ApplyCouponCodeMutation,
                CodegenShop.ApplyCouponCodeMutationVariables
            >(APPLY_COUPON_CODE, { couponCode: couponCode1 });

            await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: item1000.id,
                quantity: 1,
            });

            const { activeOrder: check1 } =
                await shopClient.query<CodegenShop.GetActiveOrderQuery>(GET_ACTIVE_ORDER);

            expect(check1!.lines[0].discountedUnitPriceWithTax).toBe(0);
            expect(check1!.totalWithTax).toBe(0);

            await shopClient.query<
                CodegenShop.ApplyCouponCodeMutation,
                CodegenShop.ApplyCouponCodeMutationVariables
            >(APPLY_COUPON_CODE, { couponCode: couponCode2 });

            const { activeOrder: check2 } =
                await shopClient.query<CodegenShop.GetActiveOrderQuery>(GET_ACTIVE_ORDER);
            expect(check2!.lines[0].discountedUnitPriceWithTax).toBe(0);
            expect(check2!.totalWithTax).toBe(0);
        });
    });

    // https://github.com/vendure-ecommerce/vendure/issues/2052
    describe('multi-channel usage', () => {
        const SECOND_CHANNEL_TOKEN = 'second_channel_token';
        const THIRD_CHANNEL_TOKEN = 'third_channel_token';
        const promoCode = 'TEST_COMMON_CODE';

        async function createChannelAndAssignProducts(code: string, token: string) {
            const result = await adminClient.query<
                Codegen.CreateChannelMutation,
                Codegen.CreateChannelMutationVariables
            >(CREATE_CHANNEL, {
                input: {
                    code,
                    token,
                    defaultLanguageCode: LanguageCode.en,
                    currencyCode: CurrencyCode.GBP,
                    pricesIncludeTax: true,
                    defaultShippingZoneId: 'T_1',
                    defaultTaxZoneId: 'T_1',
                },
            });

            await adminClient.query<
                Codegen.AssignProductsToChannelMutation,
                Codegen.AssignProductsToChannelMutationVariables
            >(ASSIGN_PRODUCT_TO_CHANNEL, {
                input: {
                    channelId: (result.createChannel as Codegen.ChannelFragment).id,
                    priceFactor: 1,
                    productIds: products.map(p => p.id),
                },
            });

            return result.createChannel as Codegen.ChannelFragment;
        }

        async function addItemAndApplyPromoCode() {
            await shopClient.asAnonymousUser();
            await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: getVariantBySlug('item-5000').id,
                quantity: 1,
            });

            const { applyCouponCode } = await shopClient.query<
                CodegenShop.ApplyCouponCodeMutation,
                CodegenShop.ApplyCouponCodeMutationVariables
            >(APPLY_COUPON_CODE, {
                couponCode: promoCode,
            });

            orderResultGuard.assertSuccess(applyCouponCode);
            return applyCouponCode;
        }

        beforeAll(async () => {
            await createChannelAndAssignProducts('second-channel', SECOND_CHANNEL_TOKEN);
            await createChannelAndAssignProducts('third-channel', THIRD_CHANNEL_TOKEN);
        });

        it('create promotion in second channel', async () => {
            adminClient.setChannelToken(SECOND_CHANNEL_TOKEN);

            const result = await createPromotion({
                enabled: true,
                name: 'common-promotion-second-channel',
                couponCode: promoCode,
                actions: [
                    {
                        code: orderPercentageDiscount.code,
                        arguments: [{ name: 'discount', value: '20' }],
                    },
                ],
                conditions: [],
            });

            expect(result.name).toBe('common-promotion-second-channel');
        });

        it('create promotion in third channel', async () => {
            adminClient.setChannelToken(THIRD_CHANNEL_TOKEN);

            const result = await createPromotion({
                enabled: true,
                name: 'common-promotion-third-channel',
                couponCode: promoCode,
                actions: [
                    {
                        code: orderPercentageDiscount.code,
                        arguments: [{ name: 'discount', value: '20' }],
                    },
                ],
                conditions: [],
            });

            expect(result.name).toBe('common-promotion-third-channel');
        });

        it('applies promotion in second channel', async () => {
            shopClient.setChannelToken(SECOND_CHANNEL_TOKEN);

            const result = await addItemAndApplyPromoCode();
            expect(result.discounts.length).toBe(1);
            expect(result.discounts[0].description).toBe('common-promotion-second-channel');
        });

        it('applies promotion in third channel', async () => {
            shopClient.setChannelToken(THIRD_CHANNEL_TOKEN);

            const result = await addItemAndApplyPromoCode();
            expect(result.discounts.length).toBe(1);
            expect(result.discounts[0].description).toBe('common-promotion-third-channel');
        });

        it('applies promotion from current channel, not default channel', async () => {
            adminClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            const defaultChannelPromotion = await createPromotion({
                enabled: true,
                name: 'common-promotion-default-channel',
                couponCode: promoCode,
                actions: [
                    {
                        code: orderPercentageDiscount.code,
                        arguments: [{ name: 'discount', value: '20' }],
                    },
                ],
                conditions: [],
            });

            shopClient.setChannelToken(SECOND_CHANNEL_TOKEN);

            const result = await addItemAndApplyPromoCode();
            expect(result.discounts.length).toBe(1);
            expect(result.discounts[0].description).toBe('common-promotion-second-channel');
        });
    });

    async function getProducts() {
        const result = await adminClient.query<Codegen.GetProductsWithVariantPricesQuery>(
            GET_PRODUCTS_WITH_VARIANT_PRICES,
            {
                options: {
                    take: 10,
                    skip: 0,
                },
            },
        );
        products = result.products.items;
    }

    async function createGlobalPromotions() {
        const { facets } = await adminClient.query<Codegen.GetFacetListQuery>(GET_FACET_LIST);
        const saleFacetValue = facets.items[0].values[0];
        await createPromotion({
            enabled: true,
            name: 'Promo not yet started',
            startsAt: new Date(2199, 0, 0),
            conditions: [minOrderAmountCondition(100)],
            actions: [freeOrderAction],
        });

        const deletedPromotion = await createPromotion({
            enabled: true,
            name: 'Deleted promotion',
            conditions: [minOrderAmountCondition(100)],
            actions: [freeOrderAction],
        });
        await deletePromotion(deletedPromotion.id);
    }

    async function createPromotion(
        input: Omit<Codegen.CreatePromotionInput, 'translations'> & { name: string },
    ): Promise<Codegen.PromotionFragment> {
        const correctedInput = {
            ...input,
            translations: [{ languageCode: LanguageCode.en, name: input.name }],
        };
        delete (correctedInput as any).name;
        const result = await adminClient.query<
            Codegen.CreatePromotionMutation,
            Codegen.CreatePromotionMutationVariables
        >(CREATE_PROMOTION, {
            input: correctedInput,
        });
        return result.createPromotion as Codegen.PromotionFragment;
    }

    function getVariantBySlug(
        slug: 'item-100' | 'item-1000' | 'item-5000' | 'item-sale-100' | 'item-sale-1000' | 'item-0',
    ): Codegen.GetProductsWithVariantPricesQuery['products']['items'][number]['variants'][number] {
        return products.find(p => p.slug === slug)!.variants[0];
    }

    async function deletePromotion(promotionId: string) {
        await adminClient.query(gql`
            mutation DeletePromotionAdHoc1 {
                deletePromotion(id: "${promotionId}") {
                    result
                }
            }
        `);
    }
});
