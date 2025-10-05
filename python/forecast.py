import argparse
import json
import sys
import pandas as pd


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--csv', required=True)
    args = parser.parse_args()

    try:
        df = pd.read_csv(args.csv)
    except Exception as e:
        sys.stderr.write(f'csv-read-failed: {e}\n')
        sys.exit(2)

    if 'date' not in df.columns or 'rating' not in df.columns:
        sys.stderr.write('csv-missing-columns\n')
        sys.exit(3)

    if len(df) == 0:
        print(json.dumps({"yhat": None}))
        return

    # Prepare for Prophet
    df = df[['date', 'rating']].copy()
    df = df.sort_values('date')
    df['ds'] = pd.to_datetime(df['date'])
    df['y'] = pd.to_numeric(df['rating'], errors='coerce')
    df = df.dropna(subset=['y'])

    try:
        from prophet import Prophet  # type: ignore
    except Exception as e:
        sys.stderr.write(f'prophet-import-failed: {e}\n')
        sys.exit(4)

    try:
        m = Prophet(daily_seasonality=True)
        m.fit(df[['ds', 'y']])
        future = m.make_future_dataframe(periods=1, freq='D')
        forecast = m.predict(future)
        yhat = forecast.iloc[-1]['yhat']
        print(json.dumps({"yhat": float(yhat)}))
    except Exception as e:
        sys.stderr.write(f'prophet-fit-failed: {e}\n')
        sys.exit(5)


if __name__ == '__main__':
    main()


