/*
- BWM Compound - 
This strategy involves triggering the compound function on the BWM Matrix contract every 10 hours in order to continue receiving the maximum payout rewards from the ROI dapp. A notification email report is then sent via email to update the status of the wallets. This compound bot supports multiple wallets and just loops through all of them. Just change the 'initWallets' code to the number you like!  

URL: https://binancewealthmatrix.com/matrix?ref=0xFdD831b51DCdA2be256Edf12Cd81C6Af79b6D7Df
*/

// Import required node modules
const scheduler = require("node-schedule");
const nodemailer = require("nodemailer");
const { ethers } = require("ethers");
const figlet = require("figlet");
require("dotenv").config();
const fs = require("fs");

// ABIs for the vault contract
const ABI = require("./vaultABI");
const TOKEN_ABI = require("./tokenABI");

// Import the environment variables
const erc20ABI = ["function balanceOf(address) view returns (uint256)"];
const VAULT = "0x174B2958095665b9afdB52c8a5372547f5C1d8AF";
const TOKEN = "0xE1a5ADD8401DFb161adb35D120CF15DBb81F0B1D";
const RPC_URL = process.env.BSC_RPC;

const addresses = {
  USDT: "0x55d398326f99059fF775485246999027B3197955",
};

// Storage obj
var restakes = {
  previousRestake: "",
  nextRestake: "",
  count: 0,
};
var report = {};

// Main Function
const main = async () => {
  let restakeExists = false;
  try {
    // check if restake file exists
    if (!fs.existsSync("./restakes.json")) await storedData();

    // get stored values from file
    const storedData = JSON.parse(fs.readFileSync("./restakes.json"));
    console.log(storedData);

    // not first launch, check data
    if ("nextRestake" in storedData) {
      const nextRestake = new Date(storedData.nextRestake);
      restakes["count"] = new Number(storedData["count"]);

      // restore claims schedule
      if (nextRestake > new Date()) {
        console.log("Restored Restake: " + nextRestake);
        scheduler.scheduleJob(nextRestake, BWMCompound);
        restakeExists = true;
      }
    }
  } catch (error) {
    console.error(error);
  }

  // first time, no previous launch
  if (!restakeExists) BWMCompound();
};

// Import wallet detail
const initWallets = (n) => {
  let wallets = [];
  for (let i = 1; i <= n; i++) {
    let wallet = {
      address: process.env["ADR_" + i],
      key: process.env["PVK_" + i],
      index: i,
      referer: "",
      downline: "",
    };

    // allocate for a circular referral system
    if (i === 1) wallet.referer = process.env["ADR_" + n];
    else wallet.referer = process.env["ADR_" + (i - 1)];
    if (i === n) wallet.downline = process.env["ADR_" + 1];
    else wallet.downline = process.env["ADR_" + (i + 1)];

    wallets.push(wallet);
  }
  return wallets;
};

// Ethers connect on each wallet
const connect = async (wallet) => {
  let connection = {};

  // Add connection properties
  connection.provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  connection.wallet = new ethers.Wallet(wallet.key, connection.provider);
  connection.contract = new ethers.Contract(VAULT, ABI, connection.wallet);
  connection.token = new ethers.Contract(TOKEN, TOKEN_ABI, connection.wallet);
  connection.usdt = new ethers.Contract(
    addresses.USDT,
    erc20ABI,
    connection.wallet
  );

  // connection established
  await connection.provider.getBalance(wallet.address);
  return connection;
};

// BWM Compound Function
const BWMCompound = async () => {
  // start function
  console.log("\n");
  console.log(
    figlet.textSync("BWMCompound", {
      font: "Standard",
      horizontalLayout: "default",
      verticalLayout: "default",
      width: 80,
      whitespaceBreak: true,
    })
  );

  // get wallet detail from .env
  const wallets = initWallets(2); //only doing 2 wallets

  // storage attributes for sending reports
  report.title = "BWM Report " + todayDate();
  report.actions = [];
  let balances = [];
  let promises = [];

  // store last compound
  restakes.previousRestake = new Date().toString();
  const t = restakes["count"];
  restakes["count"] = t + 1;

  // Claims on every 2nd time
  const claimTime = t % 2 == 0;

  // loop through for each wallet
  for (const wallet of wallets) {
    if (claimTime) {
      const action = claim(wallet);
      report.mode = "claim";
      promises.push(action);
    } else {
      const action = compound(wallet);
      report.mode = "compound";
      promises.push(action);
    }
  }

  // wait for the action promises to finish resolving
  const results = await Promise.allSettled(promises);
  for (const result of results) {
    try {
      const action = result.value;
      report.actions.push(action);
      if (action.balance) {
        balances.push(parseFloat(action.balance));
      }
    } catch (error) {
      console.error(error);
    }
  }
  promises = [];

  // calculate the average wallet size
  const average = eval(balances.join("+")) / balances.length;
  report.consolidated = { average: average };

  // report action status
  scheduleNext(new Date());
  report.schedule = restakes;
  sendReport();
};

// Claim Individual Wallet
const claim = async (wallet, tries = 1.0) => {
  const w = wallet.address.slice(0, 5) + "..." + wallet.address.slice(-6);
  try {
    // connection using the current wallet
    const connection = await connect(wallet);
    const nonce = await connection.provider.getTransactionCount(wallet.address);
    const m = Math.floor((60 * 60000) / tries);

    // set custom gasPrice
    const overrideOptions = {
      nonce: nonce,
      gasLimit: Math.floor(2000000 / tries),
      gasPrice: ethers.utils.parseUnits(tries.toString(), "gwei"),
    };

    // call the claim function and await the results
    const result = await connection.contract.matrixRedeem(overrideOptions);
    const receipt = await connection.provider.waitForTransaction(
      result.hash,
      1,
      m
    );
    const url = "https://bscscan.com/tx/" + result.hash;

    // get the total balance currently locked in the vault
    const b = await connection.contract.user(wallet.address);
    const balance = ethers.utils.formatEther(b.totalInvested);
    const claimed = ethers.utils.formatEther(b.totalRedeemed);

    // succeeded
    if (receipt) {
      const b = await connection.provider.getBalance(wallet.address);
      console.log(`Wallet${wallet["index"]}: success`);
      console.log(`Vault Balance: ${balance} CLIMB`);
      const bal = ethers.utils.formatEther(b);

      const success = {
        index: wallet.index,
        wallet: w,
        BNB: bal,
        balance: balance,
        claimed: claimed,
        tries: tries,
        url: url,
      };

      return success;
    }
  } catch (error) {
    console.log(`Wallet${wallet["index"]}: failed!`);
    console.error(error);

    // max 5 tries
    if (tries > 5) {
      // failed
      const failure = {
        index: wallet.index,
        wallet: w,
        claimToPool: false,
      };

      return failure;
    }

    // failed, retrying again...
    console.log(`retrying(${tries})...`);
    return await claim(wallet, ++tries);
  }
};

// Compound Individual Wallet
const compound = async (wallet, tries = 1.0) => {
  try {
    // connection using the current wallet
    const connection = await connect(wallet);
    const nonce = await connection.provider.getTransactionCount(wallet.address);
    const mask = wallet.address.slice(0, 5) + "..." + wallet.address.slice(-6);
    const m = Math.floor((60 * 60000) / tries);
    const ref = wallet.referer;

    // set custom gasPrice
    const overrideOptions = {
      nonce: nonce,
      gasLimit: Math.floor(2000000 / tries),
      gasPrice: ethers.utils.parseUnits(tries.toString(), "gwei"),
    };

    // call the compound function and await the results
    const result = await connection.contract.reinvestInMatrix(ref);
    const receipt = await connection.provider.waitForTransaction(
      result.hash,
      1,
      m
    );
    const url = "https://bscscan.com/tx/" + result.hash;

    // get the total balance currently locked in the vault
    const b = await connection.contract.user(wallet.address);
    const balance = ethers.utils.formatEther(b.totalInvested);

    // succeeded
    if (receipt) {
      const b = await connection.provider.getBalance(wallet.address);
      console.log(`Wallet${wallet["index"]}: success`);
      console.log(`Vault Balance: ${balance} CLIMB`);
      const bal = ethers.utils.formatEther(b);

      const success = {
        index: wallet.index,
        wallet: mask,
        BNB: bal,
        balance: balance,
        compound: true,
        tries: tries,
        url: url,
      };

      return success;
    }
  } catch (error) {
    console.log(`Wallet${wallet["index"]}: failed!`);
    console.error(error);

    // max 5 tries
    if (tries > 5) {
      // failed
      const w = wallet.address.slice(0, 5) + "..." + wallet.address.slice(-6);
      const failure = {
        index: wallet.index,
        wallet: w,
        compound: false,
      };

      return failure;
    }

    // failed, retrying again...
    console.log(`retrying(${tries})...`);
    return await compound(wallet, ++tries);
  }
};

// Job Scheduler Function
const scheduleNext = async (nextDate) => {
  // set next job to be 24hrs from now
  nextDate.setHours(nextDate.getHours() + 6);
  restakes.nextRestake = nextDate.toString();
  console.log("Next Restake: ", nextDate);

  // schedule next restake
  scheduler.scheduleJob(nextDate, BWMCompound);
  storeData();
  return;
};

// Data Storage Function
const storeData = async () => {
  const data = JSON.stringify(restakes);
  fs.writeFile("./restakes.json", data, (err) => {
    if (err) {
      console.error(err);
    } else {
      console.log("Data stored:", restakes);
    }
  });
};

// Get Climb Price Function
const climbPrice = async () => {
  try {
    // just initialize connection
    const wallets = initWallets(1);
    const connection = await connect(wallets[0]);

    // get the price of CLIMB from contract
    const rawPrice = await connection.token.price();
    const b = await connection.usdt.balanceOf(TOKEN);
    const bal = ethers.utils.formatEther(b) + " USDT";
    let price = rawPrice / 1000;
    price = Number(price).toFixed(2);
    savePrice = price;

    return { CLIMB: price, TVL: bal };
  } catch (error) {
    console.error(error);
    return null;
  }
};

// Current Date function
const todayDate = () => {
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, "0");
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const yyyy = today.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
};

// Send Report Function
const sendReport = async () => {
  try {
    // get the formatted date
    const today = todayDate();
    report.title = "BWM Report " + today;

    // get price of Furio
    const price = await climbPrice();
    report.price = price;
    console.log(report);

    // configure email server
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_ADDR,
        pass: process.env.EMAIL_PW,
      },
    });

    // setup mail params
    const mailOptions = {
      from: process.env.EMAIL_ADDR,
      to: process.env.RECIPIENT,
      subject: "BWM Report: " + today,
      text: JSON.stringify(report, null, 2),
    };

    // send the email message
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error(error);
      } else {
        console.log("Email sent: " + info.response);
      }
    });

    // clear var
    report = {};
  } catch (error) {
    console.error(error);
  }
};

main();
