-- Make child-only image and measurement changes visible to observation-level
-- incremental sync consumers.

DROP TRIGGER IF EXISTS trg_observation_images_touch_observation_updated_at
  ON public.observation_images;
DROP TRIGGER IF EXISTS trg_spore_measurements_touch_observation_updated_at
  ON public.spore_measurements;

DROP FUNCTION IF EXISTS public.touch_observation_updated_at_from_image();
DROP FUNCTION IF EXISTS public.touch_observation_updated_at_from_measurement();

CREATE FUNCTION public.touch_observation_updated_at_from_image()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.observations
    SET updated_at = now()
    WHERE id = NEW.observation_id;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    UPDATE public.observations
    SET updated_at = now()
    WHERE id IN (OLD.observation_id, NEW.observation_id);
    RETURN NEW;
  END IF;

  UPDATE public.observations
  SET updated_at = now()
  WHERE id = OLD.observation_id;
  RETURN OLD;
END;
$$;

CREATE FUNCTION public.touch_observation_updated_at_from_measurement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.observations
    SET updated_at = now()
    WHERE id IN (
      SELECT DISTINCT oi.observation_id
      FROM public.observation_images AS oi
      WHERE oi.id = NEW.image_id
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    UPDATE public.observations
    SET updated_at = now()
    WHERE id IN (
      SELECT DISTINCT oi.observation_id
      FROM public.observation_images AS oi
      WHERE oi.id IN (OLD.image_id, NEW.image_id)
    );
    RETURN NEW;
  END IF;

  UPDATE public.observations
  SET updated_at = now()
  WHERE id IN (
    SELECT DISTINCT oi.observation_id
    FROM public.observation_images AS oi
    WHERE oi.id = OLD.image_id
  );
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_observation_images_touch_observation_updated_at
AFTER INSERT OR UPDATE OR DELETE ON public.observation_images
FOR EACH ROW
EXECUTE FUNCTION public.touch_observation_updated_at_from_image();

CREATE TRIGGER trg_spore_measurements_touch_observation_updated_at
AFTER INSERT OR UPDATE OR DELETE ON public.spore_measurements
FOR EACH ROW
EXECUTE FUNCTION public.touch_observation_updated_at_from_measurement();

