-- Reverts 20260801231500: no scheduling yet (Carter). The ION transactions
-- report pull stays MANUAL — fired by the UI's Refresh bills or by running
-- f/ION/transactions_report directly — until the pipeline is signed off.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ion-transactions-month-close') THEN
    PERFORM cron.unschedule('ion-transactions-month-close');
  END IF;
END $$;
