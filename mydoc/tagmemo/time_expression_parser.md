# 中文时域解析器

**创新摘要**  
将中文时间表达映射为时间区间/日期范围，用于 Time-Aware RAG 在日记库中定向检索。

**依赖环境**  
- Node.js  
- 相关配置文件：timeExpressions.config.js  

**运行说明**  
模块为类库形式，由 RAGDiaryPlugin 调用：  
`const parser = new TimeExpressionParser(); parser.parse(text);`

---

## 完整代码实现

### 1) TimeExpressionParser.js

```javascript
const timePatterns = require('./timeExpressions.config');

class TimeExpressionParser {
    constructor() {
        this.patterns = this._loadPatterns();
    }

    _loadPatterns() {
        return timePatterns.patterns.map(p => ({
            name: p.name,
            regex: new RegExp(p.regex, 'i'),
            handler: p.handler
        }));
    }

    parse(text, referenceDate = new Date()) {
        const results = [];

        for (const pattern of this.patterns) {
            const match = text.match(pattern.regex);
            if (match) {
                try {
                    const handlerFn = this._getHandlerFunction(pattern.handler);
                    const dateRange = handlerFn(match, referenceDate);
                    if (dateRange) {
                        results.push({
                            type: pattern.name,
                            match: match[0],
                            ...dateRange
                        });
                    }
                } catch (error) {
                    console.error(`Error parsing time expression "${pattern.name}":`, error);
                }
            }
        }

        return results;
    }

    _getHandlerFunction(handlerCode) {
        return new Function('match', 'referenceDate', handlerCode);
    }
}

module.exports = TimeExpressionParser;
```

### 2) timeExpressions.config.js

```javascript
module.exports = {
    patterns: [
        {
            name: "relativeDays",
            regex: "(前|过去)?([0-9一二三四五六七八九十两]+)天",
            handler: `
                const number = parseInt(match[2]) || 
                    {一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10, 两:2}[match[2]] || 1;
                const endDate = new Date(referenceDate);
                const startDate = new Date(referenceDate);
                startDate.setDate(startDate.getDate() - number);
                return { startDate, endDate };
            `
        },
        {
            name: "relativeWeeks",
            regex: "(上|下)?([0-9一二三四五六七八九十两]+)?周(前|后)?",
            handler: `
                let offset = 0;
                if (match[1] === "上") offset = -1;
                if (match[1] === "下") offset = 1;
                if (match[2]) offset *= parseInt(match[2]) || 1;
                
                const now = new Date(referenceDate);
                const dayOfWeek = now.getDay();
                const startDate = new Date(now);
                startDate.setDate(now.getDate() - dayOfWeek + (offset * 7));
                const endDate = new Date(startDate);
                endDate.setDate(startDate.getDate() + 6);
                return { startDate, endDate };
            `
        },
        {
            name: "relativeMonths",
            regex: "(上|下)?([0-9一二三四五六七八九十两]+)?个?月",
            handler: `
                let offset = 0;
                if (match[1] === "上") offset = -1;
                if (match[1] === "下") offset = 1;
                if (match[2]) offset *= parseInt(match[2]) || 1;
                
                const now = new Date(referenceDate);
                const startDate = new Date(now);
                startDate.setMonth(now.getMonth() + offset);
                startDate.setDate(1);
                const endDate = new Date(startDate);
                endDate.setMonth(startDate.getMonth() + 1);
                endDate.setDate(0);
                return { startDate, endDate };
            `
        },
        {
            name: "relativeYears",
            regex: "(去|今|明|前|后)?([0-9一二三四五六七八九十两]+)?年",
            handler: `
                let offset = 0;
                if (match[1] === "去") offset = -1;
                if (match[1] === "今") offset = 0;
                if (match[1] === "明") offset = 1;
                if (match[1] === "前") offset = -1;
                if (match[1] === "后") offset = 1;
                if (match[2]) offset *= parseInt(match[2]) || 1;
                
                const now = new Date(referenceDate);
                const startDate = new Date(now.getFullYear() + offset, 0, 1);
                const endDate = new Date(now.getFullYear() + offset, 11, 31);
                return { startDate, endDate };
            `
        },
        {
            name: "specificDate",
            regex: "([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日",
            handler: `
                const year = parseInt(match[1]);
                const month = parseInt(match[2]) - 1;
                const day = parseInt(match[3]);
                const date = new Date(year, month, day);
                return { startDate: date, endDate: date };
            `
        },
        {
            name: "monthDay",
            regex: "([0-9]{1,2})月([0-9]{1,2})日",
            handler: `
                const year = referenceDate.getFullYear();
                const month = parseInt(match[1]) - 1;
                const day = parseInt(match[2]);
                const date = new Date(year, month, day);
                return { startDate: date, endDate: date };
            `
        },
        {
            name: "yearMonth",
            regex: "([0-9]{4})年([0-9]{1,2})月",
            handler: `
                const year = parseInt(match[1]);
                const month = parseInt(match[2]) - 1;
                const startDate = new Date(year, month, 1);
                const endDate = new Date(year, month + 1, 0);
                return { startDate, endDate };
            `
        },
        {
            name: "lunarFestival",
            regex: "(春节|元宵|端午|中秋|除夕)",
            handler: `
                const festivalMap = {
                    "春节": { month: 1, day: 1 },
                    "元宵": { month: 1, day: 15 },
                    "端午": { month: 5, day: 5 },
                    "中秋": { month: 8, day: 15 },
                    "除夕": { month: 12, day: 30 }
                };
                const festival = festivalMap[match[1]];
                if (!festival) return null;
                
                const year = referenceDate.getFullYear();
                const date = new Date(year, festival.month - 1, festival.day);
                return { startDate: date, endDate: date };
            `
        },
        {
            name: "seasonal",
            regex: "(春天|夏天|秋天|冬天)",
            handler: `
                const year = referenceDate.getFullYear();
                const seasonMap = {
                    "春天": { startMonth: 2, endMonth: 4 },
                    "夏天": { startMonth: 5, endMonth: 7 },
                    "秋天": { startMonth: 8, endMonth: 10 },
                    "冬天": { startMonth: 11, endMonth: 1 }
                };
                const season = seasonMap[match[1]];
                if (!season) return null;
                
                const startDate = new Date(year, season.startMonth - 1, 1);
                const endDate = new Date(year, season.endMonth - 1, 0);
                
                if (season.endMonth < season.startMonth) {
                    endDate.setFullYear(year + 1);
                }
                
                return { startDate, endDate };
            `
        }
    ]
};
```

---

## 验证

已通过以下命令验证模块可加载：

```bash
node -e "require('./Plugin/RAGDiaryPlugin/TimeExpressionParser');"
```
