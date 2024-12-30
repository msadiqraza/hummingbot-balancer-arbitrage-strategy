# Hummingbot Pool Arbitrage Strategy (pool_arb)

This guide provides detailed instructions for setting up and running the `pool_arb` strategy, a custom Hummingbot strategy designed for arbitrage trading on Balancer pools. It utilizes the Hummingbot Gateway to interact with the Balancer decentralized exchange.

---

## Prerequisites

- **Docker and Docker Compose**: Ensure Docker and Docker Compose are installed on your system.
- **Git**: Required to clone necessary repositories.
- **Text Editor**: For modifying configuration files.

---

## Setup Instructions

### 1. Modify Gateway Image

#### a. Clone the Gateway Repository
```bash
git clone https://github.com/coinalpha/gateway-v2  # Update URL if needed
cd gateway-v2
```

#### b. Replace Balancer Connector File
Navigate to the Balancer connector directory:
```bash
cd src/connectors/balancer
```
Replace the existing `balancer.ts` file with the provided custom `balancer.ts`. For example:
```bash
rm balancer.ts  # Delete the original file
cp /path/to/custom/balancer.ts ./  # Copy the custom file
```

#### c. Build the Custom Gateway Image
Navigate back to the root directory and build the Docker image:
```bash
cd ../../..
docker build -t hummingbot/gateway:custom .
```

---

### 2. Set Up Hummingbot Image and Strategy

#### a. Clone the Hummingbot Repository
```bash
git clone https://github.com/hummingbot/hummingbot.git
cd hummingbot
```
If already cloned, update it:
```bash
git pull
```

#### b. Add the Strategy Template
Copy `conf_pool_arb_strategy.py` from the custom strategy repository to the `hummingbot/templates` directory:
```bash
cp /path/to/conf_pool_arb_strategy.py hummingbot/templates/
```

#### c. Add the Strategy Folder
Clone the custom strategy repository into the `hummingbot/strategy` directory:
```bash
cd hummingbot/strategy
git clone https://github.com/msadiqraza/hummingbot-poolarb-strategy.git pool_arb
```

#### d. Update `docker-compose.yml`
Modify the `gateway` service in your `docker-compose.yml` file to use the custom image:
```yaml
gateway:
  image: hummingbot/gateway:custom
  # Other configuration settings
```
Ensure volume mounts include the required paths:
```yaml
volumes:
  - ./conf:/home/hummingbot/conf
  - ./conf/connectors:/home/hummingbot/conf/connectors
  - ./conf/strategies:/home/hummingbot/conf/strategies
  - ./conf/controllers:/home/hummingbot/conf/controllers
  - ./conf/scripts:/home/hummingbot/conf/scripts
  - ./logs:/home/hummingbot/logs
  - ./data:/home/hummingbot/data
  - ./certs:/home/hummingbot/certs
  - ./scripts:/home/hummingbot/scripts
  - ./controllers:/home/hummingbot/controllers
  - ./hummingbot/strategy/pool_arb:/home/hummingbot/hummingbot/strategy/pool_arb
  - ./hummingbot/templates:/home/hummingbot/hummingbot/templates
```

---

### 3. Run the Strategy

#### a. Start Hummingbot and Gateway
```bash
docker compose up -d
```

#### b. Attach to the Hummingbot Container
```bash
docker attach hummingbot
```

#### c. Create the Strategy
Inside the Hummingbot client, run:
```bash
create
```
When prompted for the strategy, enter `pool_arb`. Follow the prompts to configure parameters such as connector, trading pair, order amount, etc.

#### d. Start the Strategy
Once configured, run:
```bash
start
```

---

## Configuration Parameters

Below are key configuration parameters in `conf_pool_arb_strategy.py`:

- **`strategy`**: The name of the strategy (`pool_arb`).
- **`connector`**: Connector to use (e.g., `balancer_ethereum_mainnet`).
- **`chain`**: Blockchain (e.g., `ethereum`, `polygon`).
- **`network`**: Network (e.g., `mainnet`, `goerli`).
- **`trading_pair`**: Trading pair (e.g., `WETH-DAI`).
- **`order_amount`**: Amount of the base asset per order.
- **`slippage_buffer`**: Percentage buffer for slippage (e.g., `0.01` for 1%).
- **`minimum_profitability`**: Minimum profitability percentage (e.g., `0.0005` for 0.05%).
- **`debug_price_shim`**: Enable price simulation for testing (default: `False`).

---

## Testing and Debugging

The strategy includes extensive logging to facilitate debugging. Example log entries:

```
Updated API Price (Fixed Rate): 0.00029470706118118590121419309206649
DEX Price: 0.000295
Price Deviation: 0.10%
Deviation ensures minimum profitability...
Deviation is positive, executing BUY WETH-DAI order.
Executing trade [ connector: balancer, base: WETH, quote: DAI, amount: 1, side: SELL, price: 0.000294115 ]
Trade submitted. Transaction Hash: 0x...
```

Enable `debug_price_shim` to simulate various price scenarios during testing. Ensure to disable it for live trading.

---

## Troubleshooting

- **`create` command not prompting for parameters**: Ensure `conf_pool_arb_strategy.py` is correctly placed in the `templates` directory.
- **Strategy not initializing**: Verify the custom Gateway image and file paths in `docker-compose.yml`.
- **Docker issues**: Rebuild images after changes with:
  ```bash
  docker compose up -d --build
  ```
- **Logs not appearing**: Check volume mounts in `docker-compose.yml`.

---

## Disclaimer

This strategy is provided as an example and may require further testing before live trading. Use at your own risk. The authors and contributors are not responsible for any losses incurred.

---

## Contributions

Contributions are welcome! Submit pull requests or open issues on the corresponding GitHub repository.

