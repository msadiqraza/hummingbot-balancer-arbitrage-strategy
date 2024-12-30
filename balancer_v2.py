"""
V2 from Google Exp 1206
"""

import asyncio
from decimal import Decimal
from dataclasses import dataclass

from hummingbot.client.config.config_helpers import ClientConfigAdapter
from hummingbot.client.settings import GatewayConnectionSetting
from hummingbot.core.data_type.common import TradeType
from hummingbot.core.gateway.gateway_http_client import GatewayHttpClient
from hummingbot.core.utils.async_utils import safe_ensure_future
from hummingbot.strategy.script_strategy_base import ScriptStrategyBase


@dataclass
class TradeParams:
    """
    Handles data locally
    """

    chain: str
    network: str
    connector: str
    base: str
    quote: str
    address: str = None  # Optional, to be set later


class ArbitrageBalancer(ScriptStrategyBase):
    """
    Arbitrage strategy on Balancer using a fixed rate (e.g., from an API or calculation)
    to determine and execute profitable trades.
    """

    connector_chain_network = "balancer_ethereum_mainnet"  # Replace with your desired network
    trading_pair = "WETH-DAI"  # Replace with your desired trading pair
    order_amount = Decimal("1")  # Replace with your desired order amount
    slippage_buffer = Decimal("0.01")  # 1% slippage tolerance
    minimum_profitability = Decimal("0.0005")  # Minimum profitability threshold (e.g., 0.05%)
    markets = {connector_chain_network: {trading_pair}}
    on_going_task = False

    def __init__(self, connectors: list, config: ClientConfigAdapter = None):
        super().__init__(connectors, config)
        self.api_price = 0  # initialize to zero and fetch in on_tick
        self.dex_price = 0  # initialize to zero and fetch in on_tick

    def on_tick(self):
        """
        Executes every tick (e.g. 1s)
        """
        if not self.on_going_task:
            # Update the api_price before calling the async_task method
            self.update_api_price()
            self.on_going_task = True

            safe_ensure_future(self.arbitrage_task())
            self.on_going_task = False

    def update_api_price(self):
        """
        Method to update the api_price. Replace this with actual API call logic.
        """
        # Placeholder for API call to get the fixed rate
        # Example: fixed_rate = await fetch_fixed_rate_from_api()

        # Assuming the fixed rate is the price of WETH in terms of DAI
        # For demonstration, let's use a static value
        # self.api_price = Decimal("3486.49")  # Example fixed rate
        # 1 WETH = 1/0.00029470706118118590121419309206649 DAI

        # so DAI/WETH rate is:
        self.api_price = Decimal(0.00029470706118118590121419309206649)
        self.logger().info(f"Updated API Price (Fixed Rate): {self.api_price}")

    async def arbitrage_task(self):
        """
        Main task to execute arbitrage logic.
        """
        try:
            base, quote = self.trading_pair.split("-")
            connector, chain, network = self.connector_chain_network.split("_")
            params = TradeParams(chain=chain, network=network, connector=connector, base=base, quote=quote)

            # Fetch DEX price from Gateway
            self.dex_price = await self.fetch_dex_price(params=params)
            self.logger().info(f"DEX Price: {self.dex_price}")

            # Determine trade direction and execute
            await self.determine_and_execute_trade(params=params)
            self.logger().info("determine_and_execute_trade completed....")

        except Exception as e:
            self.logger().error(f"Error in arbitrage_task: {e}", exc_info=True)

    async def fetch_dex_price(self, params: TradeParams):
        """
        Fetches the current DEX price for the trading pair.
        """
        price_data = await GatewayHttpClient.get_instance().get_price(
            params.chain, params.network, params.connector, params.base, params.quote, self.order_amount, TradeType.BUY
        )
        return Decimal(price_data["price"])

    async def determine_and_execute_trade(self, params: TradeParams):
        """
        Determines the trade direction based on profitability and executes the trade.
        """
        trade_type = self.calculate_trade_direction()

        if trade_type:
            self.logger().info(f"Profitable trade detected: {trade_type.name}")

            # Fetch wallet address and check balances before trade
            params.address = await self.get_wallet_address(params.chain, params.network, params.connector)
            if not params.address:
                return

            await self.get_balance(params=params)

            if trade_type == TradeType.BUY:
                limit_price = self.dex_price * (1 + self.slippage_buffer)
            else:
                limit_price = self.dex_price * (1 - self.slippage_buffer)

            await self.execute_trade(
                params=params,
                trade_type=trade_type,
                limit_price=limit_price,
            )

    def calculate_trade_direction(self):
        """
        Calculates the direction of trade based on price deviation and minimum profitability.
        Returns None if no profitable trade is found.
        """
        # WETH/DAI deviation = (dex_price - api_price) / api_price
        # If deviation is positive, it means the DEX price of WETH is higher than the API price, so we should buy WETH on the DEX (SELL DAI for WETH).
        # If deviation is negative, it means the DEX price of WETH is lower than the API price, so we should sell WETH on the DEX (BUY DAI with WETH).
        # if api_price is the rate of 1 DAI in terms of WETH then, if the deviation is positive then buy else sell
        deviation = (self.dex_price - self.api_price) / self.api_price
        self.logger().info(f"Price Deviation: {deviation * 100:.2f}%")

        if abs(deviation) > float(self.minimum_profitability):
            self.logger().info("Deviation ensures minimum profitibilitty...")
            if deviation > 0:
                self.logger().info("Deviation is positive, executing BUY WETH-DAI order.")
                return TradeType.SELL  # Sell DAI for WETH
            else:
                self.logger().info("Deviation is negative, executing SELL WETH-DAI order.")
                return TradeType.BUY  # Buy DAI with WETH
        else:
            self.logger().info("No profitable arbitrage opportunity found.")
            return None

    async def get_wallet_address(self, chain, network, connector):
        """
        Fetches the wallet address for the given chain, network, and connector.
        """
        gateway_connections_conf = GatewayConnectionSetting.load()
        if len(gateway_connections_conf) < 1:
            self.notify("No existing wallet.\n")
            return

        wallet = [
            w
            for w in gateway_connections_conf
            if w["chain"] == chain and w["connector"] == connector and w["network"] == network
        ]

        if not wallet:
            self.notify(f"No wallet found for {chain}_{connector}_{network}.\n")
            return None

        return wallet[0]["wallet_address"]

    async def execute_trade(self, params: TradeParams, trade_type: TradeType, limit_price: Decimal):
        """
        Executes the trade via Gateway.
        """
        self.logger().info(
            f"Executing trade [ connector: {params.connector}, base: {params.base}, quote: {params.quote}, amount: {self.order_amount}, side: {trade_type.name}, price: {limit_price} ]"
        )
        try:
            trade_data = await GatewayHttpClient.get_instance().amm_trade(
                params.chain,
                params.network,
                params.connector,
                params.address,
                params.base,
                params.quote,
                trade_type,
                self.order_amount,
                limit_price,
            )
            tx_hash = trade_data["txHash"]
            self.logger().info(f"Trade submitted. Transaction Hash: {tx_hash}")

            # Poll for transaction confirmation
            await self.poll_transaction(params.chain, params.network, tx_hash)

            # Print resulting balances
            await self.get_balance(params=params)

            self.logger().info("Trade execution completed.")

        except Exception as e:
            self.logger().error(f"Error executing trade: {e}", exc_info=True)

    async def get_balance(self, params: TradeParams):
        """
        Uses /chain/balance to get account balance
        """

        self.logger().info(
            f"Fetching balances [ address: {params.address}, base: {params.base}, quote: {params.quote} ]"
        )
        balance_data = await GatewayHttpClient.get_instance().get_balances(
            params.chain, params.network, params.address, [params.base, params.quote]
        )
        self.logger().info(f"Balances for {params.address}: {balance_data['balances']}")

    async def poll_transaction(self, chain, network, tx_hash):
        """
        Polls to see if transaction is executed successfully
        """
        self.logger().info("Starting poll_transaction...")
        pending = True
        while pending:
            self.logger().info(f"Polling transaction status [ txHash: {tx_hash} ]")
            try:
                poll_data = await GatewayHttpClient.get_instance().get_transaction_status(chain, network, tx_hash)
                tx_status = poll_data.get("txStatus")
                if tx_status == 1:
                    self.logger().info(f"Trade with transaction hash {tx_hash} has been executed successfully.")
                    pending = False
                elif tx_status in [-1, 0, 2]:
                    self.logger().info(f"Trade is pending confirmation, Transaction hash: {tx_hash}")
                    await asyncio.sleep(self.task_cooldown)
                else:
                    self.logger().info(f"Unknown txStatus: {tx_status}")
                    self.logger().info(f"{poll_data}")
                    pending = False
            except Exception as e:
                self.logger().error(f"Error polling transaction: {e}", exc_info=True)
                pending = False

    def cancel_all_orders(self):
        """
        Placeholder for cancelling all active orders (if any).
        """
        self.logger().info("Starting cancel_all_orders...")

        for order in self.get_active_orders(connector_name=self.config.exchange):
            self.cancel(self.config.exchange, order.trading_pair, order.client_order_id)
