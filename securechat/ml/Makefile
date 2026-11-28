PY ?= python3
export PYTHONPATH := src

.PHONY: test demo demo-clean validate

test:
	$(PY) -m pytest -q

# Chạy toàn bộ pipeline trên dữ liệu DEMO (chỉ để thử đường ống, số đo KHÔNG có ý nghĩa)
demo:
	$(PY) -m securechat_ml.cli demo-data
	$(PY) -m securechat_ml.cli --demo prepare-messages
	$(PY) -m securechat_ml.cli --demo train-message
	$(PY) -m securechat_ml.cli --demo prepare-urls
	$(PY) -m securechat_ml.cli --demo train-url
	$(PY) -m securechat_ml.cli --demo export-message
	$(PY) -m securechat_ml.cli --demo export-url
	$(PY) -m securechat_ml.cli --demo parity

demo-clean:
	rm -rf data/demo/* data/splits/demo models/demo_artifacts reports/demo
	touch data/demo/.gitkeep

validate:
	$(PY) -m securechat_ml.cli validate-messages --file data/raw/messages_train_pool.csv
