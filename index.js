const keys = require('./keys');
const express = require('express');
const socket = require('socket.io');
const mqtt = require('mqtt');
const pg = require('pg');
const uuid = require('uuid/v1');
const nodemailer = require('nodemailer');

let authToken = ""; //Use this token for logging in. Not the most elegant solution. Updates every minute
let loggingEnabled = false;
let timeout;

let transporter = nodemailer.createTransport({
	service: 'gmail',
	secure: false,
	port: 25,
	auth: {
		user: keys.email.username,
		pass: keys.email.password
	},
	tls: {
	  rejectUnauthorized: false
	}
  });

  transporter.verify(function(error, success) {
	if (error) {
		 console.log(error);
	} else {
		 console.log('Server is ready to take our messages');
	}
 });

const pool = new pg.Pool({
	user: keys.db.dbUser,
	host: keys.db.dbHost,
	database: keys.db.dbName,
	password: keys.db.dbUserPassword,
	port: keys.db.dbPort
});

var clientMQTT = mqtt.connect(keys.address.mqtt);

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
				let result = analyse(telemetry.group[i].voltage[i], telemetry.group[i].temperature[i]);

				insertQuery += `INSERT INTO measurement (uuid, clock, cell_id) \
								VALUES ('${measurementUUID}', NOW(), ${cellID}); \
								INSERT INTO voltage (uuid, measured_voltage, is_voltage_ok, measurement_id) \
								VALUES ('${uuid()}', ${telemetry.group[i].voltage[i]}, ${(result.voltage === null ? true : false)}, '${measurementUUID}'); \
								INSERT INTO temperature (uuid, measured_temp, is_temp_ok, measurement_id) \
								VALUES ('${uuid()}', ${telemetry.group[i].temperature[i]}, ${(result.temperature === null ? true : false)}, '${measurementUUID}');`;

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
			if (err) {
				console.log(err);
			}
		});
	}
});


var app = express();

app.get('/token', (req, res) => {
	authToken = Math.random().toString(36).slice(2);
	clearTimeout(timeout);
	var mailOptions = {
		from: 'regniremote@gmail.com',
		to: 'henripirinen@hotmail.fi',
		subject: 'Logging token',
		text: `Your logging token: ${authToken}`
	  };

	transporter.sendMail(mailOptions, function(error, response){
        if(error){
            console.log(error);
        }else{
            console.log("Ok");
        }
	});
	loggingEnabled = true;
	timeout = setTimeout(function(){loggingEnabled = false;}, 60000); //Client need to login within one minute.
	res.end("Token send to email");
});

app.get('/verifyToken/:token', (req, res) => {
	if(req.params.token === authToken && loggingEnabled){
		loggingEnabled = false;
		res.end("Succesfull");
	} else {
		res.end("Invalid token");
	}
});

var server = app.listen(4000, () => { //Start server
	console.log("Listening port 4000 @ localhost")
	console.log("MQTT is subscribed to 'vehicleData & vehicleExternalCommand'");
});

var io = socket(server);

io.on('connection', (socket) => {
	socket.on('command', (data) => { //Commands from remote user to vehicle server
		switch (data.target) {
			case "controller_1":
				console.log("Command to controller 1");
				clientMQTT.publish('vehicleExternalCommand', data);
				break;
			case "controller_2":
				console.log("Command to controller 2");
				clientMQTT.publish('vehicleExternalCommand', data);
				break;
			case "inverter":
				console.log("Command to inverter");
				clientMQTT.publish('vehicleExternalCommand', data);
				break;
			case "server":
				console.log("Command to server");
				clientMQTT.publish('vehicleExternalCommand', data);
				break;
			default:
				console.log("Invalid target");
		}
	});
	socket.on('requestData', (req) => {
		let query = () => {
			let sqlQuery = `SELECT extract(epoch from me.clock), me.cell_id, vo.measured_voltage, te.measured_temp
			FROM measurement me
			FULL OUTER JOIN voltage vo
			ON me.uuid = vo.measurement_id
			FULL OUTER JOIN temperature te
			ON me.uuid = te.measurement_id
			WHERE me.cell_id = 0
			AND me.clock BETWEEN '${req.sDate}'
			AND '${req.eDate}'`;

			for(let i = 1; i <= 72; i++){
				let txt = `SELECT extract(epoch from me.clock), me.cell_id, vo.measured_voltage, te.measured_temp
				FROM measurement me
				FULL OUTER JOIN voltage vo
				ON me.uuid = vo.measurement_id
				FULL OUTER JOIN temperature te
				ON me.uuid = te.measurement_id
				WHERE me.cell_id = ${i}
				AND me.clock BETWEEN '${req.sDate}'
				AND '${req.eDate}'`;

				sqlQuery += ` UNION ${txt}`; 
			}

			return sqlQuery;
		}

		pool.query(query(), (err, res) => {
			let initArray = new Array(10);
			for(let i = 0; i < initArray.length; i++){
				initArray[i] = new Array(9);
				for(let cell = 0; cell < initArray[i].length; cell++){
					initArray[i][cell] = [];
				}
			}
			if (err) console.log(err);
			for(let item of res.rows){
				let group = Math.floor(item.cell_id / 8);
				let cellIdx = ((item.cell_id / 8) - (Math.floor(item.cell_id / 8))) / 0.125;
				initArray[group][cellIdx].push(`${JSON.stringify({voltage: item.measured_voltage, temperature: item.measured_temp, time: Math.round(item.date_part)})}`);
			}
			let response = {"data": initArray};
			socket.emit('dataset', {
				message: JSON.stringify(response),
				handle: 'Remote Server'
			});
		});
	})
});



var validateJSON = (string) => { //Validate JSON string
	try {
		JSON.parse(string);
	} catch (e) {
		console.log(e);
		return false;
	}
	return true;
}

var uploadData = () => {
	clientMQTT.publish('vehicleExternalCommand', '$commandFromRemote');
}

var analyse = (voltage, temperature) => {
	let errorMsg = { 'voltage': null, 'temperature': null };

	if (voltage > 3.80 || voltage < 2.75) {
		if (voltage > 3.80) errorMsg.voltage = `WARNING: HIGH VOLTAGE ( ${voltage}V ). `;
		if (voltage < 2.75) errorMsg.voltage = `WARNING: LOW VOLTAGE ( ${voltage}V ). `;
	}

	if (temperature > 90 || temperature < 0) {
		if (temperature > 90) errorMsg.temperature = `WARNING: HIGH TEMPERATURE ( ${temperature}C ). `;
		if (temperature < 0) errorMsg.temperature = `WARNING: LOW TEMPERATURE ( ${temperature}C ). `;
	}

	return errorMsg;
}