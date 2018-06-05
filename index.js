const keys = require('./keys');
const express = require('express');
const socket = require('socket.io');
const mqtt = require('mqtt');
const pg = require('pg');
const uuid = require('uuid/v1');

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

				insertQuery += "INSERT INTO measurement (uuid, clock, cell_id) \
								VALUES ('" + measurementUUID + "', NOW(), " + cellID + "); \
								INSERT INTO voltage (uuid, measured_voltage, is_voltage_ok, measurement_id) \
								VALUES ('" + uuid() + "', " + telemetry.group[i].voltage[i] + ", " + (result.voltage === null ? true : false) + ", '" + measurementUUID + "'); \
								INSERT INTO temperature (uuid, measured_temp, is_temp_ok, measurement_id) \
								VALUES ('" + uuid() + "', " + telemetry.group[i].temperature[i] + ", " + (result.temperature === null ? true : false) + ", '" + measurementUUID + "');";

				if(result.voltage != null || result.temperature != null){
					let logMsg;
					if(result.voltage != null) logMsg += result.voltage;
					if(result.temperature != null) logMsg += result.temperature;
					
					insertQuery += "INSERT INTO log (uuid, error_msg, cleared, measurement_uuid) \
					VALUES ('" + uuid() + "', '" + logMsg + "', false, '" + measurementUUID + "');";
				}
			}
		}

		pool.query(insertQuery, (err, res) => {
			console.log(res);
			console.log(err);
		});
	}
});


var app = express();
var server = app.listen(4000, () => { //Start server
	console.log("Listening port 4000 @ localhost")
	console.log("MQTT is subscribed to 'vehicleData & vehicleExternalCommand'");
});

var io = socket(server);

io.on('connection', (socket) => {
	socket.emit('webSocket', {		//Send notification to new client 
		message: 'WebSocket connected!',
		handle: 'Server'
	});

	socket.on('command', (data) => { //Write command to arduino via USB

		switch (data.target) {
			case "controller_1":
				//TODO
				break;
			case "controller_2":
				//TODO
				break;
			case "inverter":
				//TODO
				console.log("Command to inverter");
				break;
			case "server":
				console.log("Command to server");
				break;
			default:
				console.log("Invalid target");
		}
	});
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
	//TODO: commands -> L64
}

var analyse = (voltage, temperature) => {
	let errorMsg = {'voltage':null,'temperature':null};

	if(voltage > 3.80 || voltage < 2.75){
		if(voltage > 3.80) errorMsg.voltage = 'WARNING: HIGH VOLTAGE ( ' + voltage + 'V ). ';
		if(voltage < 2.75) errorMsg.voltage = 'WARNING: LOW VOLTAGE ( ' + voltage + 'V ). ';
		//console.log('Found something!');
	}

	if(temperature > 90 || temperature < 0){
		if(temperature > 90) errorMsg.temperature = 'WARNING: HIGH TEMPERATURE ( ' + temperature + 'C ). ';
		if(temperature < 0) errorMsg.temperature = 'WARNING: LOW TEMPERATURE ( ' + temperature + 'C ). ';
		//console.log('Found something!');
	}

	return errorMsg;
}

setInterval(uploadData, 5000);