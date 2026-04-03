/* eslint-disable camelcase */
import response from '../../../utils/response.js';
import DashboardRepositories from '../repositories/dashboard-repositories.js';

export const getStats = async (req, res, next) => {
  try {
    const { source_files, jobs } = await DashboardRepositories.getStats();

    const processedToday = parseInt(source_files.processed_today);
    const processedYesterday = parseInt(source_files.processed_yesterday);

    let percentageChange = null;
    if (processedYesterday > 0) {
      percentageChange = parseFloat(
        (((processedToday - processedYesterday) / processedYesterday) * 100).toFixed(1)
      );
    } else if (processedToday > 0) {
      percentageChange = 100;
    } else {
      percentageChange = 0;
    }

    return response(res, 200, 'Berhasil mengambil statistik dashboard', {
      processed_today: {
        count: processedToday,
        percentage_change: percentageChange,
      },
      currently_processing: {
        count: parseInt(source_files.currently_processing),
      },
      completed_jobs: {
        count: parseInt(jobs.completed_today),
      },
      failed_jobs: {
        count: parseInt(jobs.failed_today),
      },
    });
  } catch (error) {
    return next(error);
  }
};