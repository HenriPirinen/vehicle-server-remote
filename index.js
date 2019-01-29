const keys = require('./keys');
const express = require('express');
const bodyParser = require("body-parser");
const socket = require('socket.io');
const mqtt = require('mqtt');
const pg = require('pg');
const uuid = require('uuid/v1');
const nodemailer = require('nodemailer');
const path = require('path');
const cookieParser = require('cookie-parser');
const redis = require('redis');
const http = require("http");
const https = require("https");
const fs = require("fs");
const crypto = require("crypto");

const options = {
	key: fs.readFileSync("/etc/letsencrypt/live/chl650.net/privkey.pem"),
	cert: fs.readFileSync("/etc/letsencrypt/live/chl650.net/cert.pem"),
	ca: fs.readFileSync("/etc/letsencrypt/live/chl650.net/chain.pem")
};

const redisClient = redis.createClient();

redisClient.on('connect', function () {
	console.log('Redis client connected');
})

const transporter = nodemailer.createTransport({
	service: 'gmail',
	secure: false,
	port: 25,
	auth: {
		user: keys.email.myUsername,
		pass: keys.email.myPassword
	},
	tls: {
		rejectUnauthorized: false
	}
});

transporter.verify(function (error, success) {
	if (error) {
		console.log(error);
	} else {
		console.log('Server is ready to take our messages');
	};
});

const pool = new pg.Pool({
	user: keys.db.dbUser,
	host: keys.db.dbHost,
	database: keys.db.dbName,
	password: keys.db.dbUserPassword,
	port: keys.db.dbPort
});

const auth = new pg.Pool({
	user: keys.db.dbUser,
	host: keys.db.dbHost,
	database: 'auth',
	password: keys.db.dbUserPassword,
	port: keys.db.dbPort
});

const clientMQTT = mqtt.connect(keys.address.mqtt, keys.mqttOptions);

clientMQTT.on('connect', () => {
	clientMQTT.subscribe('vehicleData');
	clientMQTT.subscribe('vehicleExternalCommand');
});

clientMQTT.on('message', (topic, message) => {
	if (topic !== 'vehicleExternalCommand') {
		let telemetry = JSON.parse(message.toString());
		let cellID = 0;
		let insertQuery = '';

		for (let x = 0; x < telemetry.group.length; x++) { //For telemetry data structure go to vehicle-server index.js. Object @ line 10.
			for (let i = 0; i < telemetry.group[i].voltage.length; i++ , cellID++) { //Voltage & temperature array length is equal
				let measurementUUID = uuid();
				let result = analyse(telemetry.group[x].voltage[i], telemetry.group[x].temperature[i]);

				insertQuery += `INSERT INTO measurement (uuid, clock, cell_id) \
								VALUES ('${measurementUUID}', NOW(), ${cellID}); \
								INSERT INTO voltage (uuid, measured_voltage, is_voltage_ok, measurement_id) \
								VALUES ('${uuid()}', ${telemetry.group[x].voltage[i]}, ${(result.voltage === null ? true : false)}, '${measurementUUID}'); \
								INSERT INTO temperature (uuid, measured_temp, is_temp_ok, measurement_id) \
								VALUES ('${uuid()}', ${telemetry.group[x].temperature[i]}, ${(result.temperature === null ? true : false)}, '${measurementUUID}');`;

				if (result.voltage != null || result.temperature != null) {
					let logMsg;
					if (result.voltage != null) logMsg += result.voltage;
					if (result.temperature != null) logMsg += result.temperature;

					insertQuery += `INSERT INTO log (uuid, error_msg, cleared, measurement_uuid) \
					VALUES ('${uuid()}', '${logMsg}', false, '${measurementUUID}');`;
				}
			}
		}

		pool.query(insertQuery, (err, res) => {
			if (err) console.log(err);
		});
	};
});

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(__dirname, { dotfiles: 'allow' } ));
app.use(function (req, res, next) {
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
	next();
});
app.use('/webApp/', express.static(path.join(__dirname, 'webApp')));
app.get('/*', function (req, res) {
	res.sendFile(path.join(__dirname, 'webApp', 'index.html'));
});

const serverHTTPS = https.createServer(options, app).listen(443, () => {
	console.log('Listening port 443');
});

app.post('/auth', function (req, res) {
	let query = `SELECT EXISTS(
		SELECT true 
		FROM users
		WHERE email = $1 
		AND password = crypt($2, password)
		);`;
	
	auth.query(query, [`${req.body.email}`, `${req.body.password}`],(err, response) => {
		if (response.rows[0].exists) {
			let authToken = crypto.randomBytes(20).toString('hex');
			redisClient.set(req.body.email, authToken);
			redisClient.expire(req.body.email, 1800); //Expire token after half hour

			res.cookie('session_key', authToken, { maxAge: 1800000 }).json({ "success": true, 'key': authToken });
		} else {
			res.json({ 'success': false });
		};
	});
});

app.post('/getData', function (req, response) {
	redisClient.get(req.body.user, function (err, reply) {
		if (reply === req.body.key) { //Check if key is valid
			let query = () => {
				let sqlQuery = `SELECT extract(epoch from me.clock), me.cell_id, vo.measured_voltage, te.measured_temp
					FROM measurement me
					FULL OUTER JOIN voltage vo
					ON me.uuid = vo.measurement_id
					FULL OUTER JOIN temperature te
					ON me.uuid = te.measurement_id
					WHERE me.cell_id = 0
					AND me.clock BETWEEN '${req.body.sDate} 00:00:00'
					AND '${req.body.eDate} 23:59:59'`;

				for (let i = 1; i <= 72; i++) {
					let txt = `SELECT extract(epoch from me.clock), me.cell_id, vo.measured_voltage, te.measured_temp
						FROM measurement me
						FULL OUTER JOIN voltage vo
						ON me.uuid = vo.measurement_id
						FULL OUTER JOIN temperature te
						ON me.uuid = te.measurement_id
						WHERE me.cell_id = ${i}
						AND me.clock BETWEEN '${req.body.sDate} 00:00:00'
						AND '${req.body.eDate} 23:59:59'`;

					sqlQuery += ` UNION ${txt}`;
				};

				return sqlQuery;
			};

			pool.query(query(), (err, res) => {
				if(!err){
					let initArray = new Array(10);
					//Create data array
					for (let i = 0; i < initArray.length; i++) {
						initArray[i] = new Array(8);
						for (let cell = 0; cell < initArray[i].length; cell++) {
							initArray[i][cell] = [];
						};
					};
	
					//Fill data array
					for (let item of res.rows) {
						let group = Math.floor(item.cell_id / 8); //Calculate group number
						let cellIdx = ((item.cell_id / 8) - (Math.floor(item.cell_id / 8))) / 0.125; //Calculate cell index in group array
						initArray[group][cellIdx].push(`${JSON.stringify({ voltage: item.measured_voltage, temperature: item.measured_temp, time: Math.round(item.date_part) })}`);
					}

					response.json({ "data": initArray })
				} else {
					console.log(err);
					res.end();
				}
			});
		} else {
			res.end(); //Unknown user
		}
	})
});

app.post('/webasto', function (req, res) {
	redisClient.get(req.body.user, function(err, rep){
		if (rep === req.body.key) {
			clientMQTT.publish('vehicleExternalCommand', req.body.command);
			res.json({ 'success': true });
		} else {
			res.end();
		}
	})
});

app.post('/update', function (req, res) {
	redisClient.get(req.body.user, function(err, rep){
		if (rep === req.body.key) {
			console.log(req.body.target);
			res.end();
		} else {
			res.end();
		}
	})
});

var io = socket(serverHTTPS);
io.on('connection', (socket) => {
	//Possibly used in the future
});

var analyse = (voltage, temperature) => {
	let errorMsg = { 'voltage': null, 'temperature': null };

	if (voltage > 3.80 || voltage < 2.75) {
		if (voltage > 3.80) errorMsg.voltage = `WARNING: HIGH VOLTAGE ( ${voltage}V ). `;
		if (voltage < 2.75) errorMsg.voltage = `WARNING: LOW VOLTAGE ( ${voltage}V ). `;
	};

	if (temperature > 90 || temperature < 0) {
		if (temperature > 90) errorMsg.temperature = `WARNING: HIGH TEMPERATURE ( ${temperature}C ). `;
		if (temperature < 0) errorMsg.temperature = `WARNING: LOW TEMPERATURE ( ${temperature}C ). `;
	};

	return errorMsg;
};