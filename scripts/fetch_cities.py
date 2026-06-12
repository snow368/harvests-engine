import sys
import requests
from bs4 import BeautifulSoup
import pandas as pd
import re

def fetch_cities(state_name):
    # 修改 Wikipedia URL 中的州名
    url = f"https://en.wikipedia.org/wiki/List_of_municipalities_in_{state_name}"
    response = requests.get(url)
    
    # 检查页面是否存在
    if response.status_code != 200:
        # 备用 URL：有时页面标题会不同
        url = f"https://en.wikipedia.org/wiki/List_of_cities_in_{state_name}"
        response = requests.get(url)
        if response.status_code != 200:
            print(f"Error: Could not find Wikipedia page for {state_name}")
            return None

    soup = BeautifulSoup(response.text, 'lxml')
    
    # 找到城市表格。Wikipedia 上的表格通常用 'wikitable sortable' 这样的 CSS 类
    table = soup.find('table', {'class': 'wikitable'})
    if not table:
        # 尝试找第一个表格
        table = soup.find('table')

    if table:
        # 使用 pandas 的 read_html 函数来解析表格，非常方便
        df = pd.read_html(str(table))[0]
        # 通常第一列是城市名，也可能是一个叫 'Municipality' 或 'City' 的列
        # 这里我们简单地取第一列，并过滤掉像 "Total" 这样的无效行
        city_col = df.columns[0]
        cities = df[city_col].to_list()
        
        # 简单的数据清洗：移除纯数字、标点或空值，以及可能的州名本身
        cleaned_cities = []
        for city in cities:
            city_str = str(city).strip()
            if city_str and city_str != state_name and not re.match(r'^[\d.]+$', city_str) and '[' not in city_str:
                cleaned_cities.append(city_str)
        
        return cleaned_cities
    else:
        print(f"Error: No table found on the Wikipedia page for {state_name}.")
        return None

if __name__ == "__main__":
    if len(sys.argv) > 1:
        state = sys.argv[1]
        cities = fetch_cities(state)
        if cities:
            # 将结果保存到文件，供 Node.js 读取
            output_file = f"{state}_cities.txt"
            with open(output_file, 'w', encoding='utf-8') as f:
                for city in cities:
                    f.write(city + '\n')
            print(f"Success: Saved {len(cities)} cities to {output_file}")
        else:
            print("Failed to fetch cities.")
    else:
        print("Usage: python fetch_cities.py <StateName>")