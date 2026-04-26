import airportData from 'airport-data-js';

const { getAirportByIata } = airportData;

export const getCountryFromIATA = async (iataCode) => {
  if (!iataCode || typeof iataCode !== 'string') return null;
  const sanitizedCode = iataCode.trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(sanitizedCode)) {
    return null;
  }

  try {
    // Library me-return Promise yang berisi array of airports
    const [airport] = await getAirportByIata(sanitizedCode);

    return airport?.country_code || null;

  } catch (error) {
    console.warn(`[Airport Mapper] IATA Code '${sanitizedCode}' lookup failed: ${error.message}`);
    return null;
  }
};