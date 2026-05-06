.PHONY: create-volume run-container stop-container view-logs view-ps

VOLUME_NAME := pb_data
COMPOSE_FILE := compose.yaml

create-volume:
	podman volume exists $(VOLUME_NAME) || podman volume create $(VOLUME_NAME)

run-container: create-volume
	podman compose -f $(COMPOSE_FILE) up -d

stop-container:
	podman compose -f $(COMPOSE_FILE) down

view-logs:
	podman compose -f $(COMPOSE_FILE) logs -f

view-ps:
	podman compose -f $(COMPOSE_FILE) ps

serve:
	python3 -m http.server 8083