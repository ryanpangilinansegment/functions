/** This function takes payloads generated by Personas and modifies them before sending to Braze. Notes:
 * We replace userId with the braze_userid trait if available. 
 * We must ping Profile API to look up the braze_userid trait.
 * Personas only sends Identify or Track calls so no handling needed for other call types.
 * We send Personas data to Braze's track endpoint: https://www.braze.com/docs/api/endpoints/user_data/post_user_track/
 * If the user does not have a braze_userid, we look for an email and send email to Braze as a user_alias to create a profile.
 * Once a user has a braze_userid, we merge the user_alias profile with the known user using Braze's identify endpoint.
 * Braze does not accept objects so this function removes objects from properties or traits.
 * Braze also does not accept one-dimensional arrays for custom event properties so these are removed as well.
 * Finally, Braze does accept one-dimensional arrays with string elements for custom attributes so these are sent through if all elements in the array are strings. Details here: https://www.braze.com/docs/developer_guide/platform_wide/analytics_overview/#custom-event-properties.
 */

/*** API CALLS ***/
/* Identify Handler */
async function onIdentify(event, settings) {
	/* Settings and variables */
	let profileApiToken = settings.profileApiKey;
	let spaceId = settings.personasSpaceId;
	let userId = event.userId;
	let brazeIdTraitName = 'braze_userid';
	let emailTraitName = 'email'; //<changes> added a variable to hold the name of the email trait
	let email = event.traits.email;
	let responses = [];
	/* Sanitize traits in case of arrays or objects. For custom attributes, Braze supports an array of strings as trait values but not nested objects. */
	let traits = event.traits;
	let cleanedTraits = sanitizePayload(traits, true);
	/* Profile API Endpoint to grab braze_userid trait specifically */
	let profileUrl =
		'https://profiles.segment.com/v1/spaces/' +
		spaceId +
		'/collections/users/profiles/user_id:' +
		userId +
		'/traits?include=' +
		brazeIdTraitName +
		',' +
		emailTraitName; //<changes> added email to query
	let brazeIdValue = '';
	let lastSeenEmail = ''; //<changes> added a variable to hold the value of the email found in the profile api (last seen email)
	let profileApiAuthHeaders = new Headers({
		Authorization: 'Basic ' + btoa(profileApiToken + ':')
	});

	/* If no userId, check for email in payload. These are the anonymous users that we will send to Braze using an email user_alias */
	/* Must explicitly set _update_existing_only to false when using user_alias to create profiles: https://www.braze.com/docs/api/endpoints/user_data/post_user_track/#request-components */
	if (!userId) {
		if (email) {
			const payload = {
				attributes: [
					{
						user_alias: {
							alias_name: email, //<changes> not a change but just note that the email from the event will only be used here when the user is anonymous
							alias_label: 'email_address'
						},
						_update_existing_only: false,
						...cleanedTraits //<changes> not a change but just note that the email from the event will only be used here when the user is anonymous
					}
				]
			};
			let response = await sendBrazeTrack(event, settings, payload);
			/* Print results to console */
			console.log('Anonymous user Braze track payload:', payload);
			console.log('Anonymous user Braze track response:', response);
			return response;
		} else throw new ValidationError('No email available for anonymous user');
		/* If no email either, we cannot send to Braze */
	}

	/* If there is a userId, we will grab the braze_userid from Profile API and map this to Braze's external_id. These are the known users */
	if (userId) {
		const fetchIdFromPersonas = await fetch(profileUrl, {
			method: 'GET',
			headers: profileApiAuthHeaders
		});
		/* Check if profile API returns a 5xx or 429 or 404; retry these errors */
		if (
			fetchIdFromPersonas.status >= 500 ||
			fetchIdFromPersonas.status === 429 ||
			fetchIdFromPersonas.status === 404
		) {
			throw new RetryError(
				'Profile API Error: ' +
					fetchIdFromPersonas.status +
					'. Segment will retry these requests up to 9 times over a four hour period, with exponential backoff. For more information, visit https://segment.com/docs/personas/profile-api/#errors.'
			);
		} else if (
			/* Check if profile API returns a 4xx error that is not 429 or 404; do not retry these errors */
			fetchIdFromPersonas.status < 500 &&
			fetchIdFromPersonas.status > 399 &&
			fetchIdFromPersonas.status !== 429 &&
			fetchIdFromPersonas.status !== 404
		) {
			throw new Error(
				'Profile API Error: ' +
					fetchIdFromPersonas.status +
					'. User does not exist or Profile API credentials are incorrect. Segment will not retry these requests. For more information, visit https://segment.com/docs/personas/profile-api/#errors.'
			);
		}
		let profileApiResponse = await fetchIdFromPersonas.json();
		/* If Profile API response does not return traits, throw error */
		if (!profileApiResponse.traits) {
			throw new ValidationError(
				'No braze_userid or email available for known user'
			); //<changes> added email to this error message
		}

		// Grab braze_userid value from Profile API and set to variable
		if (brazeIdTraitName in profileApiResponse.traits) {
			brazeIdValue = profileApiResponse.traits[brazeIdTraitName];
		} else
			throw new ValidationError('No braze_userid available for known user');

		// <changes> Grab email value from Profile API and set to variable
		if (emailTraitName in profileApiResponse.traits) {
			lastSeenEmail = profileApiResponse.traits[emailTraitName];
		} else throw new ValidationError('No email available for known user');

		/* For known users, there might also be an anonymous alias profile so we need to merge the two in this case using the identify endpoint: https://www.braze.com/docs/api/endpoints/user_data/post_user_identify/ */
		/* Note: If we try to ping the identify endpoint with a nonexistent user_alias the request will fail silently. It will be considered a 201 success but Braze will not ingest anything. We may see an error saying the alias_name must be a string since email is missing. This doesn't cause any issues though. */
		/* Note: If we try to ping the identify endpoint with a nonexistent external_id Braze will create a new user with that external_id and bind the user_alias to it */
		const brazeIdentifyPayload = {
			aliases_to_identify: [
				{
					external_id: brazeIdValue,
					user_alias: {
						alias_name: lastSeenEmail, //<changes> set alias name to last seen email
						alias_label: 'email_address'
					}
				}
			]
		};

		/* <changes> overwrite email in event to last seen email. */
		event.traits.email = lastSeenEmail;

		/* <changes> remove email from payload */
		delete event.traits.email;

		let brazeIdentifyResponse = await sendBrazeIdentify(
			event,
			settings,
			brazeIdentifyPayload
		);
		/* Print results to console. This could be blank if the email user_alias does not exist. */
		console.log('Braze alias-to-identify event', event); //<changes> add event payload results
		console.log('Braze alias-to-identify payload:', brazeIdentifyPayload);
		console.log('Braze alias-to-identify response:', brazeIdentifyResponse);
		/* Push response into responses array */
		responses.push(brazeIdentifyResponse);

		/* <changes> overwrite email in cleaned traits to last seen email. */
		cleanedTraits.email = lastSeenEmail;

		/* <changes> delete email from payload */
		delete cleanedTraits.email;

		/* After merging, construct user attributes object for Braze's track endpoint with braze_userid. Details here: https://www.braze.com/docs/api/objects_filters/user_attributes_object/ */
		const brazeTrackPayload = {
			attributes: [
				{
					external_id: brazeIdValue,
					...cleanedTraits
				}
			]
		};
		let brazeTrackResponse = await sendBrazeTrack(
			event,
			settings,
			brazeTrackPayload
		);
		/* Print results to console */
		console.log('Known user Braze event payload', event); //<changes> add event payload results
		console.log('Known user Braze track payload:', brazeTrackPayload);
		console.log('Known user Braze track response:', brazeTrackResponse);
		/* Push response into responses array */
		responses.push(brazeTrackResponse);
		/* Print responses array to console */
		console.log('Braze responses array:', responses);
		return responses;

		/* Catch all in case, shouldn't hit this */
	} else
		throw new InvalidEventPayload(
			'No braze_userid or email available for user'
		);
}

/* Track Handler */
async function onTrack(event, settings) {
	/* Settings and variables */
	let profileApiToken = settings.profileApiKey;
	let spaceId = settings.personasSpaceId;
	let userId = event.userId;
	let brazeIdTraitName = 'braze_userid';
	let emailTraitName = 'email'; //<changes> added a variable to hold the name of the email trait
	let email = event.context.traits.email;

	let eventName = event.event;
	let appId = settings.appIdentifier;
	let responses = [];
	/* Sanitize properties in case of arrays or objects. Braze does not support arrays or nested objects for custom track event properties. */
	let properties = event.properties;
	let cleanedProps = sanitizePayload(properties, false);
	/* Profile API Endpoint to grab braze_userid trait specifically */
	let profileUrl =
		'https://profiles.segment.com/v1/spaces/' +
		spaceId +
		'/collections/users/profiles/user_id:' +
		userId +
		'/traits?include=' +
		brazeIdTraitName +
		',' +
		emailTraitName; //<changes> added email to query
	let brazeIdValue = '';
	let profileApiAuthHeaders = new Headers({
		Authorization: 'Basic ' + btoa(profileApiToken + ':')
	});
	let lastSeenEmail = ''; //<changes> added a variable to hold the value of the email found in the profile api (last seen email)

	/* If no userId, check for email in payload. These are the anonymous users that we will send to Braze using an email user_alias */
	/* Must explicitly set _update_existing_only to false when using user_alias to create profiles: https://www.braze.com/docs/api/endpoints/user_data/post_user_track/#request-components */
	if (!userId) {
		if (email) {
			const payload = {
				events: [
					{
						user_alias: {
							alias_name: email, //<changes> not a change but just note that the email from the event will only be used here when the user is anonymous
							alias_label: 'email_address'
						},
						_update_existing_only: false,
						name: eventName,
						app_id: appId || '',
						time: event.timestamp,
						properties: cleanedProps //<changes> not a change but just note that the email from the event will only be used here when the user is anonymous
					}
				]
			};
			let response = await sendBrazeTrack(event, settings, payload);
			/* Print results to console */
			console.log('Anonymous user Braze track payload:', payload);
			console.log('Anonymous user Braze track response:', response);
			return response;
		} else throw new ValidationError('No email available for anonymous user');
		/* If no email either, we cannot send to Braze */
	}

	/* If there is a userId, we will grab the braze_userid from Profile API and map this to Braze's external_id. These are the known users */
	if (userId) {
		/* Retrieve braze_userid using Profile API */
		const fetchIdFromPersonas = await fetch(profileUrl, {
			method: 'GET',
			headers: profileApiAuthHeaders
		});

		/* Check if profile API returns a 5xx or 429 or 404; retry these errors */
		if (
			fetchIdFromPersonas.status >= 500 ||
			fetchIdFromPersonas.status === 429 ||
			fetchIdFromPersonas.status === 404
		) {
			throw new RetryError(
				'Profile API Error: ' +
					fetchIdFromPersonas.status +
					'. Segment will retry these requests up to 9 times over a four hour period, with exponential backoff. For more information, visit https://segment.com/docs/personas/profile-api/#errors.'
			);
		} else if (
			/* Check if profile API returns a 4xx error that is not 429 or 404; do not retry these errors */
			fetchIdFromPersonas.status < 500 &&
			fetchIdFromPersonas.status > 399 &&
			fetchIdFromPersonas.status !== 429 &&
			fetchIdFromPersonas.status !== 404
		) {
			throw new Error(
				'Profile API Error: ' +
					fetchIdFromPersonas.status +
					'. User does not exist or Profile API credentials are incorrect. Segment will not retry these requests. For more information, visit https://segment.com/docs/personas/profile-api/#errors.'
			);
		}
		let profileApiResponse = await fetchIdFromPersonas.json();
		/* If Profile API response does not return traits, throw error */
		if (!profileApiResponse.traits) {
			throw new ValidationError(
				'No braze_userid or email available for known user'
			); //<changes> added email to this error message
		}

		// Grab braze_userid value from Profile API and set to variable
		if (brazeIdTraitName in profileApiResponse.traits) {
			brazeIdValue = profileApiResponse.traits[brazeIdTraitName];
		} else
			throw new ValidationError('No braze_userid available for known user');

		// <changes> Grab email value from Profile API and set to variable
		if (emailTraitName in profileApiResponse.traits) {
			lastSeenEmail = profileApiResponse.traits[emailTraitName];
		} else throw new ValidationError('No email available for known user');

		/* For known users, there might also be an anonymous alias profile so we need to merge the two in this case using the identify endpoint: https://www.braze.com/docs/api/endpoints/user_data/post_user_identify/ */
		/* Note: If we try to ping the identify endpoint with a nonexistent user_alias the request will fail silently. It will be considered a 201 success but Braze will not ingest anything. We may see an error saying the alias_name must be a string since email is missing. This doesn't cause any issues though. */
		/* Note: If we try to ping the identify endpoint with a nonexistent external_id Braze will create a new user with that external_id and bind the user_alias to it */
		const brazeIdentifyPayload = {
			aliases_to_identify: [
				{
					external_id: brazeIdValue,
					user_alias: {
						alias_name: lastSeenEmail, //<changes> set alias name to last seen email
						alias_label: 'email_address'
					}
				}
			]
		};

		/* <changes> overwrite email in event to last seen email. */
		event.context.traits.email = lastSeenEmail;
		event.properties.email = lastSeenEmail;

		/* <changes> remove email from payload */
		delete event.context.traits.email;
		delete event.properties.email;

		let brazeIdentifyResponse = await sendBrazeIdentify(
			event,
			settings,
			brazeIdentifyPayload
		);
		/* Print results to console. This could be blank if the email user_alias does not exist. */
		console.log('Braze alias-to-identify event', event); //<changes> add event payload results
		console.log('Braze alias-to-identify payload:', brazeIdentifyPayload);
		console.log('Braze alias-to-identify response:', brazeIdentifyResponse);
		/* Push response into responses array */
		responses.push(brazeIdentifyResponse);

		/* <changes> overwrite email in cleaned traits to last seen email. */
		cleanedProps.email = lastSeenEmail;

		/* <changes> remoove email from payload */
		delete cleanedProps.email;

		/* After merging, construct events object for Braze's track endpoint with braze_userid, event name and properties. Details here: https://www.braze.com/docs/api/objects_filters/event_object/ */
		const brazeTrackPayload = {
			events: [
				{
					external_id: brazeIdValue,
					name: eventName,
					app_id: appId || '',
					time: event.timestamp,
					properties: cleanedProps
				}
			]
		};
		let brazeTrackResponse = await sendBrazeTrack(
			event,
			settings,
			brazeTrackPayload
		);
		/* Print results to console */
		console.log('Known user Braze event payload', event); //<changes> add event payload results
		console.log('Known user Braze track payload:', brazeTrackPayload);
		console.log('Known user Braze track response:', brazeTrackResponse);
		/* Push response into responses array */
		responses.push(brazeTrackResponse);
		/* Print responses array to console */
		console.log('Braze responses array:', responses);
		return responses;

		/* Catch all in case, shouldn't hit this */
	} else
		throw new InvalidEventPayload(
			'No braze_userid or email available for user'
		);
}

/*** HELPER FUNCTIONS ***/
/* Clean payloads if there is an object or non-string array */
function sanitizePayload(payload, allowStringArrays) {
	let sanitizedPayload = Object.assign({}, payload);
	_.forEach(payload, (value, key) => {
		if (isUnsanitaryValue(value, allowStringArrays)) {
			delete sanitizedPayload[key];
		}
	});
	return sanitizedPayload;
}

/* Check for object or array */
function isUnsanitaryValue(value, allowStringArrays) {
	/* Objects are never accepted. This uses the lodash _.isObject function: https://lodash.com/docs/4.17.15#isObject */
	if (_.isObject(value) && !Array.isArray(value)) {
		return true;
	}
	if (Array.isArray(value)) {
		/* Track calls do not allow any arrays even if strings */
		if (!allowStringArrays) {
			return true;
		}
		/* Only send array of identify traits if all elements are strings */
		return value.some(elem => typeof elem !== 'string');
	}
	return false;
}

/* Define sendBrazeTrack function to send to Braze's track endpoint: https://www.braze.com/docs/api/endpoints/user_data/post_user_track/ */
async function sendBrazeTrack(event, settings, data) {
	/* Settings */
	let customApi = settings.customRestApiEndpoint;
	let groupKey = settings.restApiKey;

	/* Construct Braze endpoint and payload */
	if (customApi) {
		brazeTrackEndpoint = 'https://' + customApi + '/users/track';
	} else brazeTrackEndpoint = 'https://api.appboy.com/users/track';

	const trackEndpoint = brazeTrackEndpoint;
	const payload = {
		...data
	};

	/* Make call to Braze track API */
	const requestOptions = {
		body: JSON.stringify(payload),
		headers: new Headers({
			Authorization: 'Bearer ' + groupKey,
			'Content-Type': 'application/json'
		}),
		method: 'POST'
	};

	const res = await fetch(trackEndpoint, requestOptions);
	console.log('Braze track response:', res);

	/* Throw retry error if Braze returns 5xx for internal server errors or 429 for rate limits */
	if (res.status >= 500 || res.status === 429) {
		throw new RetryError(
			'Braze Error: ' +
				res.status +
				' ' +
				res.statusText +
				'. Segment will retry these requests up to 9 times over a four hour period, with exponential backoff. For more information, visit https://www.braze.com/docs/api/errors/.'
		);
		/* Throw bad request error if Braze's API returns 4xx that isn't 429 and does not accept call */
	} else if (res.status < 500 && res.status > 399 && res.status !== 429) {
		throw new Error(
			'Braze Error: ' +
				res.status +
				' ' +
				res.statusText +
				'. For more information, visit https://www.braze.com/docs/api/errors/.'
		);
	}
	return res.json();
}

/* Define sendBrazeIdentify function to send to Braze's identify endpoint: https://www.braze.com/docs/api/endpoints/user_data/post_user_identify/ */
async function sendBrazeIdentify(event, settings, data) {
	/* Settings */
	let customApi = settings.customRestApiEndpoint;
	let groupKey = settings.restApiKey;

	/* Construct Braze endpoint and payload */
	if (customApi) {
		brazeIdentifyEndpoint = 'https://' + customApi + '/users/identify';
	} else brazeIdentifyEndpoint = 'https://api.appboy.com/users/identify';

	const identifyEndpoint = brazeIdentifyEndpoint;
	const payload = {
		...data
	};

	/* Make call to Braze identify API */
	const requestOptions = {
		body: JSON.stringify(payload),
		headers: new Headers({
			Authorization: 'Bearer ' + groupKey,
			'Content-Type': 'application/json'
		}),
		method: 'POST'
	};

	const res = await fetch(identifyEndpoint, requestOptions);
	console.log('Braze identify response:', res);

	/* Throw retry error if Braze returns 5xx for internal server errors or 429 for rate limits */
	if (res.status >= 500 || res.status === 429) {
		throw new RetryError(
			'Braze Error: ' +
				res.status +
				' ' +
				res.statusText +
				'. Segment will retry these requests up to 9 times over a four hour period, with exponential backoff. For more information, visit https://www.braze.com/docs/api/errors/.'
		);
		/* Throw bad request error if Braze's API returns 4xx that isn't 429 and does not accept call */
	} else if (res.status < 500 && res.status > 399 && res.status !== 429) {
		throw new Error(
			'Braze Error: ' +
				res.status +
				' ' +
				res.statusText +
				'. For more information, visit https://www.braze.com/docs/api/errors/.'
		);
	}
	return res.json();
}
