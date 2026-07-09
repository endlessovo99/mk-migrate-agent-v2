# Issue #19 MK JS snippet click verification

Captured from the NewOA SIT template designer JS snippet drawer on 2026-07-09. Each target function node under the requested categories was clicked once, the right-side Monaco editor output was captured, and the editor content was restored without saving the template.

- Template page: https://p-sit.onewo.com/web/#/manage/km-review/kmReviewTemplate/edit/1jt2nnqicw57ew6u3lw3kvk33k99v1cd2qw0/designer
- Runtime source: `window.MKXFORMAPIS`
- Requested categories: 常用变量、通用函数、主表函数、明细表函数、子明细表函数、流程函数、组织架构函数
- Total clicked snippets: 116
- Verification: all listed nodes were found and clicked; right-side editor output is recorded below.

## Summary

| Category | Count | Found | Clicked |
| --- | ---: | ---: | ---: |
| 常用变量 | 5 | 5 | 5 |
| 通用函数 | 13 | 13 | 13 |
| 主表函数 | 9 | 9 | 9 |
| 明细表函数 | 18 | 18 | 18 |
| 子明细表函数 | 11 | 11 | 11 |
| 流程函数 | 15 | 15 | 15 |
| 组织架构函数 | 45 | 45 | 45 |

## 常用变量

Runtime group: `vars`. Count: 5.

### 内置表单

- API/name: `mkXform`
- Purpose: 访问 MK 表单运行时根对象，是所有 MKXFORM API 的入口。
- Click verified: yes

Inserted code from right editor:

```javascript
MKXFORM
```

### 视图状态

- API/name: `viewStatus`
- Purpose: 判断当前表单处于新建、编辑、查看等视图状态，用于按页面状态分支处理。
- Click verified: yes

Inserted code from right editor:

```javascript
MKXFORM.viewStatus
```

### 流程状态

- API/name: `docStatus`
- Purpose: 读取流程/单据状态，用于按流程状态控制字段、按钮或校验逻辑。
- Click verified: yes

Inserted code from right editor:

```javascript
MKXFORM.docStatus
```

### 设备端

- API/name: `platform`
- Purpose: 判断当前运行端是桌面端还是移动端，用于选择 PC/mobile 专用 API。
- Click verified: yes

Inserted code from right editor:

```javascript
MKXFORM.platform
```

### 表单ID

- API/name: `formId`
- Purpose: 读取当前表单模板或实例相关 ID，用于接口调用或上下文追踪。
- Click verified: yes

Inserted code from right editor:

```javascript
MKXFORM.formId
```

## 通用函数

Runtime group: `global`. Count: 13.

### 异步请求

- API/name: `ajax`
- Purpose: 发起自定义异步请求，用于迁移旧脚本中的后端查询、数据联动或接口校验。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
  * 异步请求
  * @param config 请求参数配置
  * @param callback 回调函数
  * 说明：
  * 请求参数配置 config
  * 可参考文档： http://axios-js.com/zh-cn/docs/index.html
  * 回调函数 callback
  * 1. 参数error，当请求出错是会返回错误信息
  * 2. 参数res，请求数据
  */
MKXFORM.ajax({
  method: '',
  url: ''
}, function (error, res) {

})
```

### 获取多语言信息

- API/name: `getLocale`
- Purpose: 按当前语言返回多语言文本，用于迁移多语言提示、标题或弹窗文案。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
  * 获取多语言信息
  * @param messages 文本信息 格式为: {Cn: '中文', Us: '英文'}，返回当前语言对应文字。为空则返回当前语言标志
  */
  MKXFORM.getLocale()
```

### 强制触发验证

- API/name: `validateFields`
- Purpose: 主动触发表单校验并拿到校验结果，用于提交前或联动后强制校验。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 触发表单强制校验
* @returns Promise<value: {errors, value, values}>
*/
  MKXFORM.validateFields().then(value => {
    // 校验返回结果
})
```

### 获取表单基础配置信息

- API/name: `getFormConfigs`
- Purpose: 读取当前表单基础配置，用于需要根据模板配置分支的高级脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 获取表单基础配置信息
* @returns 配置信息
*/
var config = MKXFORM.getFormConfigs()
```

### 获取整个表单值

- API/name: `getFormValues`
- Purpose: 一次性读取整张表单值，用于提交前汇总、批量校验或接口入参组装。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 获取整个表单值
* @returns 表单值
*/
var values = MKXFORM.getFormValues()
```

### 全局提示[仅支持桌面端]

- API/name: `message`
- Purpose: 在桌面端显示全局提示，用于替换旧脚本中的 alert 或页面提示。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* message全局提示
*/
MKXFORM.message.success(全局成功提示)
```

### 全局提示[仅支持移动端]

- API/name: `toast`
- Purpose: 在移动端显示轻提示，用于移动端反馈成功、失败或警告状态。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* toast全局提示
* @param options {
*   content: 全局提示,
*   icon: 'success'|'fail'|'warning'
* }
*/
MKXFORM.toast({
  content: '全局成功提示',
  icon: 'success',
})
```

### confirm弹窗[仅支持桌面端]

- API/name: `modal`
- Purpose: 在桌面端弹出确认框，用于需要用户确认后继续执行的交互。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* confirm弹出窗
* @param options 配置
*/
MKXFORM.modal({
    title: '是否关闭弹窗',
    content: '关闭则不再显示',
    onOk() {
      console.log('点击确认')
    },
    onCancel() {
      console.log('点击取消')
    },
})
```

### confirm弹窗[仅支持移动端]

- API/name: `mobileModal`
- Purpose: 在移动端弹出确认框，用于移动端确认交互。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* confirm弹出窗
* @param options 配置
*/
MKXFORM.mobileModal({
    title: '是否关闭弹窗',
    content: '关闭则不再显示',
    onConfirm() {
      console.log('点击确认')
    },
    onCancel() {
      console.log('点击取消')
    },
})
```

### 表格弹窗[仅支持桌面端]

- API/name: `tableModal`
- Purpose: 在桌面端弹出表格弹窗，用于展示接口返回的列表数据供用户查看或选择。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
  * 表格弹窗
  * @param options 配置
  * 说明：具体配置可参考
  * modal 为弹窗的配置
  * table 为表格的配置
  * 说明：具体配置可参考 https://ant.design/index-cn 中的Modal、Table组件API
  */
MKXFORM.tableModal({
  modal: {
    onOk() {
      console.log(点击确认)
    },
    onCancel() {
      console.log(点击取消)
    },
  },
  table: {
    columns: [
      {
          title: 'Name',
          key: 'name',
          dataIndex: 'name'
      },
      {
          title: 'Age',
          key: 'age',
          dataIndex: 'age'
      },
      {
          title: 'Address',
          key: 'address',
          dataIndex: 'address'
      },
      {
          title: 'Tags',
          key: 'tags',
          dataIndex: 'tags'
      }
    ],
    dataSource: [
      {
          key: '1',
          name: 'John Brown',
          age: 32,
          address: 'New York No. 1 Lake Park',
          tags: 'cool',
      }
    ]
}
})
```

### HTML弹窗[仅支持桌面端]

- API/name: `HTMLModal`
- Purpose: 在桌面端弹出自定义 HTML 内容，用于迁移复杂提示或只读展示界面。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
  * HTML 弹窗
  * @param options 配置
  * 说明：具体配置可参考 https://4x.ant.design/components/modal-cn 中的Modal组件API
  * 其中content数据可以直接编写HTML
  */
MKXFORM.HTMLModal({
  onOk() {
    console.log('点击确认')
  },
  onCancel() {
    console.log('点击取消')
  },
  //显示确定按钮
  //okButtonProps:{style: {display: ''}},
  //显示取消按钮
  // okCancel:true,
  content: '<div><span>HTML</span></div>'
})
```

### 执行业务操作

- API/name: `executeOperation`
- Purpose: 触发配置好的业务操作按钮，用于脚本中主动执行业务动作。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
  * 执行业务操作
  * @param operation 操作按钮配置
  * @param params 参数配置
  * 说明：
  * operation参数:code为操作按钮类型(add/other等), uniqueCode为操作按钮编码, platform为设备类型(pc|mobile)
  * params参数:fdCode为表单编码,fdType为表单类型(0|1|2),callback为操作完成回调，同步调用业务触发时有效
  *
  */
MKXFORM.executeOperation({
  code:'',
  uniqueCode:'',
  platform:'pc'
},{
  fdType:0,
  fdCode:'',
  callback:(res)=>{
    console.log(res)
  }
})
```

### 业务操作权限校验

- API/name: `authOperation`
- Purpose: 校验业务操作权限，用于执行操作前判断当前用户是否可用。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
  * 业务操作权限校验
  * @param operation 操作按钮配置
  * @param params 参数配置
  * @param callback 回调函数
  * 说明：
  * operation参数：code为操作按钮类型(add/other等), uniqueCode为操作按钮编码
  * params参数:fdCode为表单编码,docId主文档id(查看页面有效)
  * 回调函数 callback
  * 1.参数error，当请求出错是会返回错误信息
  * 2.参数res，请求数据
  */
MKXFORM.authOperation({
  code:'',
  uniqueCode:''
},{
  fdCode:'',
  docId:''
},function(error,res){
  console.log(error,res)
})
```

## 主表函数

Runtime group: `function`. Count: 9.

### 根据控件ID获取对象

- API/name: `$`
- Purpose: 按控件 ID 获取主表控件对象，用于进一步读取或操作控件实例。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
 * 根据控件ID获取对象
 * @param id 控件ID，可在数据模型中选中，格式[表ID.控件ID]
 * @returns 控件对象
 */
MKXFORM.$('控件ID')
```

### 根据控件ID设置值

- API/name: `setValue`
- Purpose: 按控件 ID 写入主表字段值，是旧表单 SetXFormFieldValueById 的主要迁移目标。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 根据控件ID设置值，暂不支持（明细表、二维码、关联流程、按钮、多表头、
* 文本说明、样例模板、多标签、自定义界面、内嵌页、审批、附件、视频、图片、附件类等控件)
* @param id 控件ID，可在数据模型中选中，格式[表ID.控件ID]
* @param value 控件值
*/
MKXFORM.setValue('控件ID','控件值')
```

### 根据控件ID获取值

- API/name: `getValue`
- Purpose: 按控件 ID 读取字段值，支持带明细/子明细行号读取嵌套字段。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 根据控件ID获取值，暂不支持（前端计算、图片、附件、滑块、
* 大明细表、多表头、文本说明、样例模板、多标签、自定义界面、
* 二维码、审批、关联流程、内嵌页、按钮）
* @param id 控件ID，可在数据模型中选中，格式[表ID.控件ID]
* @param extra 可选参数，包含detailRowIndex、nestRowIndex属性的对象。detailRowIndex，明细表的行号，从0开始的整数；nestRowIndex，子明细表的行号，从0开始的整数
* @returns 控件值
*/
var value = MKXFORM.getValue('控件ID', { detailRowIndex: 明细表行号, nestRowIndex: 子明细表行号 })
```

### 根据控件ID设置样式

- API/name: `setStyle`
- Purpose: 动态设置主表字段标题或内容样式，主要用于查看态视觉控制。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 根据控件ID设置样式。仅支持桌面端控件（单行文本、多行文本、日期、地址本、金额、
* 数值、单选框、多选框、单选下拉框、多选下拉框、滑块、开关），仅支持阅读态
* @param id 控件ID，可在数据模型中选中，格式[表ID.控件ID]
* @param style 样式
* @param type 类型 label控件标题 content控件内容
*/
MKXFORM.setStyle('控件ID', { display : 'block' }, 'content')
```

### 根据控件ID设置属性

- API/name: `setProps`
- Purpose: 动态设置控件属性，用于高级控件行为或展示属性调整。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 根据控件ID设置属性
* @param id 控件ID，可在数据模型中选中，格式[表ID.控件ID]
* @param props 属性集合
*/
MKXFORM.setProps(控件ID,{})
```

### 获取字段当前的只读/必填属性

- API/name: `getFieldAttr`
- Purpose: 读取字段当前只读、可编辑、必填、隐藏等显示属性。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 获取字段当前的只读/必填属性
* @param id 控件ID，可在数据模型中选中，格式[表ID.控件ID]
* @returns 1：只读，2：可编辑，3：必填， 4：隐藏字段标签及内容
*/
var attr  = MKXFORM.getFieldAttr(控件ID)
```

### 改变单个字段显示属性(只读/必填等)

- API/name: `setFieldAttr`
- Purpose: 设置字段只读、可编辑、必填、隐藏、显示、非必填等状态。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 改变单个字段显示属性(只读/必填等)
* @param id 控件ID，可在数据模型中选中，格式[表ID.控件ID]
* @param value 1：只读，2：可编辑，3：必填， 4：隐藏字段标签及内容，5：显示，6：非必填
*/
MKXFORM.setFieldAttr(控件ID, 1)
```

### 根据控件ID获取显示值

- API/name: `getValueText`
- Purpose: 读取字段显示文本，用于选择类、组织类等值和显示值不同的控件。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* @param id 控件ID，可在数据模型中选中，格式[表ID.控件ID]
* @returns 根据控件ID获取显示值
*/
var value = MKXFORM.getValueText('表ID.控件ID')
```

### 获取控件带样式html字符串

- API/name: `getControlHtml`
- Purpose: 获取控件带样式 HTML 字符串，用于打印、预览或自定义展示。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* @param id 控件ID，可在数据模型中选中，格式[表ID.控件ID]
* @returns 获取控件带样式html字符串
*/
var value = MKXFORM.getControlHtml('控件ID')
```

## 明细表函数

Runtime group: `detail`. Count: 18.

### 获取指定控件值

- API/name: `getControlValue`
- Purpose: 读取明细表某行某字段值，用于迁移明细行内计算、校验或联动。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 获取指定控件值。暂不支持（前端计算、图片、附件、多表头、
* 文本说明、样例模板、多标签、业务关联、自定义界面、内嵌页、
* 二维码、审批、关联流程、按钮）
* @param id 控件ID，可在数据模型中选中，格式[表ID.控件ID]
* @param rowIndex 指定更新行 下标以0开始
* @param value 控件值
*/
var value = MKXFORM.getControlValue(控件ID, rowIndex)
```

### 更新指定控件值

- API/name: `updateControl`
- Purpose: 更新明细表某行某字段值，用于迁移明细行内联动写值。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 更新指定控件值。暂不支持（前端计算、图片、附件、多表头、
* 文本说明、样例模板、多标签、业务关联、自定义界面、内嵌页、
* 二维码、审批、关联流程、按钮）
* @param id 控件ID，可在数据模型中选中，格式[表ID.控件ID]
* @param rowNum 指定更新行 下标以0开始
* @param value  控件值
*/
MKXFORM.updateControl(控件ID, rowNum, value)
```

### 更新指定控件样式

- API/name: `updateControlStyle`
- Purpose: 设置明细表某行字段样式，主要用于桌面端查看态的行内视觉控制。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 更新指定控件样式，仅支持桌面端控件（单行文本、多行文本、日期、地址本、金额，
* 数值、单选框、多选框、单选下拉框、多选下拉框、滑块、开关），仅支持阅读态
* @param id fmtMsg(':desc.updateControl4', '控件ID，可在数据模型中选中，格式[表ID.控件ID]')
* @param rowNum 行序号
* @param style 样式
*/
MKXFORM.updateControlStyle(控件ID, rowNum, { display : 'block' })
```

### 新增行

- API/name: `addRow`
- Purpose: 向明细表新增一行，可携带行数据包。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 新增行
* @param id 明细表ID
* @param rowValue 行数据包(非必填)
*/
MKXFORM.addRow(明细表ID, rowValue)
```

### 更新行

- API/name: `updateRow`
- Purpose: 整体更新明细表指定行的数据包。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 更新行
* @param id 明细表ID
* @param rowNum 行序号
* @param rowValue 行数据包
*/
MKXFORM.updateRow(明细表ID, rowNum, rowValue)
```

### 删除行

- API/name: `deleteRow`
- Purpose: 删除明细表指定行、多个行或全部行。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 删除行
* @param id 明细表ID
* @param rowNum 行序号(删除多个传值[rowNum1,rowNum2...],不传值则为删除全部)
*/
MKXFORM.deleteRow(明细表ID, rowNum)
```

### 获取明细表总行数(不能在表单onLoad里获取)

- API/name: `getRowCount`
- Purpose: 读取明细表总行数，用于循环处理、行数校验或汇总计算。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 获取明细表总行数(不能在表单onLoad里获取)
* @param id 明细表ID
* @returns 行数
*/
var count = MKXFORM.getRowCount(明细表ID)
```

### 获取明细选中行下标

- API/name: `getSelectedRowIndex`
- Purpose: 读取用户当前选中的明细行下标集合。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 获取明细选中行下标
* @param id 明细表ID
* @returns [1,2] 选中的行集合
*/
var indexArr = MKXFORM.getSelectedRowIndex(明细表ID)
```

### 选中明细指定行

- API/name: `checkDetailRow`
- Purpose: 程序化选中明细表指定行。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 选中明细指定行。不支持移动端
* @param id 明细表ID
* @param [1,2] 选中的行集合，下标以0开始
*/
MKXFORM.checkDetailRow(明细表ID, [])
```

### 控制明细行是否可删除（暂时仅支持PC端）

- API/name: `controlDetailRowCanDelete`
- Purpose: 控制指定明细行是否允许删除。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 控制明细行是否可删除（暂时仅支持PC端）
* @param id 明细表ID
* @param canDeleteRow 是否可以删除行 true/false
* @param rowNum 明细表索引值或者明细表索引值数组
*/
MKXFORM.controlDetailRowCanDelete(id, canDeleteRow, rowNum)
```

### 计算明细表某列最大最小平均值

- API/name: `cacluColumnValue`
- Purpose: 计算明细表某一列最大值、最小值和平均值。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 计算明细表某列最大最小平均值
* @param id 明细表ID. 控件ID
* @returns {max: 最大值, min: 最小值, average: 平均值}
*/
var caluValues =  MKXFORM.cacluColumnValue(明细表ID. 控件ID)
```

### 获取当前分页指定控件值

- API/name: `getPageControlValue`
- Purpose: 读取明细表某行某字段值，用于迁移明细行内计算、校验或联动。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 获取当前分页指定控件值（PC端）。暂不支持（前端计算、图片、附件、
* 明细表、大明细表、多表头、文本说明、样例模板、多标签、业务关联、
* 自定义界面、内嵌页、二维码、审批、关联流程、按钮
* @param id 控件ID，可在数据模型中选中，格式[表ID.控件ID]
* @param rowNum 指定更新行 下标以0开始
* @param value 控件值
*/
MKXFORM.getPageControlValue(控件ID, rowNum)
```

### 改变明细表单个字段显示属性(只读/必填等)

- API/name: `setDetailFieldAttr`
- Purpose: 动态控制明细字段或明细行的只读、必填、隐藏、显示等属性。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 改变明细表单个字段显示属性(只读/必填等)。
* @param id 控件ID，可在数据模型中选中，格式[表ID.控件ID]
* @param value 1：只读，2：可编辑，3：必填， 4：隐藏字段标签及内容，5：显示，6：非必填
*/
MKXFORM.setDetailFieldAttr(控件ID, 1)
```

### 改变明细表指定行显示属性(只读/必填等)

- API/name: `setDetailRowAttr`
- Purpose: 动态控制明细字段或明细行的只读、必填、隐藏、显示等属性。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 改变明细表指定行显示属性(只读/必填等)。
* @param id 明细表控件ID，格式[表ID]
* @param value 1：只读，2：可编辑，3：必填， 4：隐藏字段标签及内容，5：显示，6：非必填
* @param rowNum 行序号
* @param fieldId 控件ID，可在数据模型中选中，格式[表ID.控件ID](可改变指定行某个字段的显示属性，不传值则改变整行)
*/
MKXFORM.setDetailRowAttr(明细表控件ID, 1, 0)
```

### 改变明细表指定行指定属性(只读/必填等)

- API/name: `setDetailFieldItemAttr`
- Purpose: 动态控制明细字段或明细行的只读、必填、隐藏、显示等属性。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 改变明细表指定行指定属性(只读/必填等)。
* @param id 明细表控件ID，格式[表ID]
* @param value 1：只读，2：可编辑，3：必填， 4：隐藏字段标签及内容，5：显示，6：非必填
* @param rowNum 行序号
* @param fieldId 控件ID，可在数据模型中选中，格式[表ID.控件ID](可改变指定行某个字段的显示属性，不传值则改变整行)
*/
MKXFORM.setDetailFieldItemAttr(明细表控件ID, 1, 0)
```

### 重新加载明细表数据

- API/name: `reload`
- Purpose: 重新加载明细表数据，适合外部数据变化后的刷新。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 重新加载明细表数据。不支持移动端
* @param id 明细表ID
*/
MKXFORM.reload(明细表ID)
```

### 禁用明细表操作

- API/name: `disabledOperation`
- Purpose: 禁用明细表行操作，如编辑、插入、复制、删除、查看详情等。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 禁用明细表操作。不支持移动端
* @param id 控件ID，可在数据模型中选中，格式[表ID.控件ID]
* @param limitList 要限制的操作['edit（编辑）', 'insert（插入）', 'addNest（添加子表）', 'copy（复制）', 'delete（删除）', 'viewDetail（查看详情）', 'isTrace（留痕）']，传false则禁用全部
* @param rowNum 行号
*/
MKXFORM.disabledOperation(控件ID, [限制列表], [行号])
```

### 设置明细表数据

- API/name: `setDetailValues`
- Purpose: 一次性设置明细表全部行数据。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 设置明细表数据
* @param id 控件ID
* @param values 行数据包[]
*/
MKXFORM.setDetailValues(控件ID, values)
```

## 子明细表函数

Runtime group: `nestDetails`. Count: 11.

### 新增行

- API/name: `addNestRow`
- Purpose: 向指定明细行下的子明细表新增一行。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 新增行
* @param id 明细表ID.子明细表ID
* @param parentRowIndex 明细表行号
* @param rowValue 行数据包
*/
MKXFORM.addNestRow(明细表ID.子明细表ID, parentRowIndex, rowValue)
```

### 更新行

- API/name: `updateNestRow`
- Purpose: 更新指定明细行下子明细表的某一行数据。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 更新行
* @param id 明细表ID.子明细表ID
* @param parentRowIndex 明细表行号
* @param nestRowIndex 子明细表行号
* @param rowValue 行数据包
*/
MKXFORM.updateNestRow(明细表ID.子明细表ID, parentRowIndex, nestRowIndex, rowValue)
```

### 删除行

- API/name: `deleteNestRow`
- Purpose: 删除指定明细行下子明细表的某一行。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 删除行
* @param id 明细表ID.子明细表ID
* @param parentRowIndex 明细表行号
* @param nestRowIndex 子明细表行号
*
*/
MKXFORM.deleteNestRow(明细表ID.子明细表ID, parentRowIndex, nestRowIndex)
```

### 获取指定控件值

- API/name: `getNestControlValue`
- Purpose: 读取子明细表某行某字段值，用于嵌套明细计算或校验。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 获取指定控件值。暂不支持（前端计算、图片、附件、多表头、
* 文本说明、样例模板、多标签、业务关联、自定义界面、内嵌页、
* 二维码、审批、关联流程、按钮）
* @param id 控件ID，可在数据模型中选中，格式[明细表ID.子明细表ID.控件ID]
* @param parentRowIndex 明细表行号
* @param nestRowIndex 子明细表行号
*/
const value = MKXFORM.getNestControlValue(明细表ID.子明细表ID.控件ID, parentRowIndex, nestRowIndex)
```

### 更新指定控件值

- API/name: `updateNestControl`
- Purpose: 更新子明细表某行某字段值，用于嵌套明细联动写值。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 更新指定控件值。暂不支持（前端计算、图片、附件、多表头、
* 文本说明、样例模板、多标签、业务关联、自定义界面、内嵌页、
* 二维码、审批、关联流程、按钮）
* @param id 控件ID，可在数据模型中选中，格式[明细表ID.子明细表ID.控件ID]
* @param parentRowIndex 明细表行号
* @param nestRowIndex 子明细表行号
* @param value  控件值
*/
MKXFORM.updateNestControl(明细表ID.子明细表ID.控件ID, parentRowIndex, nestRowIndex, value)
```

### 更新指定控件样式

- API/name: `updateNestControlStyle`
- Purpose: 更新子明细表某行某字段值，用于嵌套明细联动写值。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 更新指定控件样式，仅支持桌面端控件（单行文本、多行文本、日期、地址本、金额，
* 数值、单选框、多选框、单选下拉框、多选下拉框、滑块、开关），仅支持阅读态
* @param id 控件ID，可在数据模型中选中，格式[明细表ID.子明细表ID.控件ID]
* @param parentRowIndex 明细表行号
* @param nestRowIndex 子明细表行号
* @param style 样式
*/
MKXFORM.updateNestControlStyle(明细表ID.子明细表ID.控件ID, parentRowIndex, nestRowIndex, { color : 'red' })
```

### 获取子明细表总行数(不能在表单onLoad里获取)

- API/name: `getNestRowCount`
- Purpose: 读取某个父明细行下子明细表的总行数。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 获取子明细表总行数(不能在表单onLoad里获取)
* @param id 明细表ID.子明细表ID
* @param parentRowIndex 明细表行号
* @returns 行数
*/
const count = MKXFORM.getNestRowCount(明细表ID.子明细表ID, parentRowIndex)
```

### 获取子明细选中行下标

- API/name: `getSelectedNestRowIndex`
- Purpose: 读取子明细表当前选中行下标集合。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 获取子明细选中行下标
* @param id 明细表ID.子明细表ID
* @param parentRowIndex 明细表行号
* @returns [1,2] 选中的行集合
*/
const indexArr = MKXFORM.getSelectedNestRowIndex(明细表ID.子明细表ID, 明细表行号)
```

### 选中子明细指定行

- API/name: `checkNestDetailRow`
- Purpose: 程序化选中子明细表指定行。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 选中明细指定行。不支持移动端
* @param id 明细表ID.子明细表ID
* @param parentRowIndex 明细表行号
* @param [1,2] 选中的行集合，下标以0开始
*/
MKXFORM.checkNestDetailRow(明细表ID.子明细表ID, parentRowIndex, [])
```

### 禁用子明细表操作

- API/name: `disabledNestOperation`
- Purpose: 禁用子明细表行操作，如编辑、插入、复制、删除等。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 禁用子明细表操作。不支持移动端
* @param id 明细表ID.子明细表ID
* @param limitList 要限制的操作['edit（编辑）', 'insert（插入）', 'addNest（添加子表）', 'copy（复制）', 'delete（删除）', 'viewDetail（查看详情）', 'isTrace（留痕）']，传false则禁用全部
* @param parentRowIndex 明细表行号
* @param nestRowIndex 子明细表行号
*/
MKXFORM.disabledNestOperation(明细表ID.子明细表ID, limitList, parentRowIndex, nestRowIndex)
```

### 改变子明细表指定行指定属性(只读/必填等)

- API/name: `setNestDetailFieldItemAttr`
- Purpose: 动态控制子明细表指定行或字段的只读、必填、隐藏、显示等属性。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 改变子明细表指定行指定属性(只读/必填等)。
* @param id 明细表ID.子明细表ID
* @param value 1：只读，2：可编辑，3：必填， 4：隐藏字段标签及内容，5：显示，6：非必填
* @param parentRowIndex 明细表行号
* @param nestRowIndex 子明细表行号
* @param fieldId 控件ID，可在数据模型中选中，格式[表ID.控件ID](可改变指定行某个字段的显示属性，不传值则改变整行)
*/
MKXFORM.setNestDetailFieldItemAttr(明细表ID.子明细表ID, value, parentRowIndex, nestRowIndex, fieldId?)
```

## 流程函数

Runtime group: `lbpm`. Count: 15.

### 获取审批提交信息

- API/name: `getLbpmFormValues`
- Purpose: 获取审批提交信息并触发流程校验，适合提交前读取流程提交上下文。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 获取审批提交信息
* 此方法会触发流程的校验
* @returns 提交信息，promise对象
*/
var config = MKXFORM.getLbpmFormValues()
```

### 获取审批当前操作的配置信息

- API/name: `getOperationParameter`
- Purpose: 读取当前审批操作配置，用于按按钮或操作类型分支。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 获取审批当前操作的配置信息
* @returns 配置信息
*/
var config = MKXFORM.getOperationParameter()
```

### 获取当前处理人的身份信息列表

- API/name: `getIdentity`
- Purpose: 获取当前处理人的身份列表，用于流程身份相关判断。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 获取当前处理人的身份信息列表
* @returns 信息列表
*/
var config = MKXFORM.getIdentity()
```

### 获取当前流程实例ID

- API/name: `getProcessInstanceId`
- Purpose: 读取当前流程实例 ID，用于流程接口调用入参。
- Click verified: yes

Inserted code from right editor:

```javascript
MKXFORM.processInstanceId
```

### 获取流程基础信息

- API/name: `promise_获取流程基础信息`
- Purpose: 通过 MKXFORM.callLbpm 调用流程平台能力：获取流程基础信息，用于迁移依赖流程上下文、节点、任务、处理人或模板信息的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用流程平台接口，接口名称：获取流程基础信息
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"object","properties":{"createTime":{"type":"integer","id":"createTime","required":true,"description":"流程创建时间(用户提交时间),毫秒时间戳"},"creator":{"type":"object","id":"creator","description":"流程创建人","properties":{"dynamicProps":{"type":"object","id":"dynamicProps","description":"多语言"},"fdIsAvailable":{"type":"boolean","id":"fdIsAvailable","description":"是否有效"},"id":{"type":"string","id":"id","description":"组织架构id"},"loginName":{"type":"string","id":"loginName","description":"用户名称,只在类型为人员或身份时存在"},"name":{"type":"string","id":"name","description":"组织架构名称"},"number":{"type":"string","id":"number","description":"编号"},"orgType":{"type":"integer","id":"orgType","description":"组织架构类型,与生态组织一致  1:机构 2:部门 4:岗位 8:人员 16:群组 128:公共岗位 256:身份"},"parent":{"type":"object","id":"parent","description":"上级","properties":{"id":{"type":"string","id":"id","description":"组织架构id"},"name":{"type":"string","id":"name","description":"组织架构名称"}}},"post":{"type":"object","id":"post","description":"岗位","properties":{"id":{"type":"string","id":"id","description":"组织架构id"},"name":{"type":"string","id":"name","description":"组织架构名称"}}}}},"endTime":{"type":"integer","id":"endTime","description":"流程结束时间,毫秒时间戳"},"initTime":{"type":"integer","id":"initTime","required":true,"description":"流程初始化时间,毫秒时间戳"},"name":{"type":"string","id":"name","required":true,"description":"流程名称,标题"},"number":{"type":"string","id":"number","required":true,"description":"流程编号"},"parentProcessInstanceId":{"type":"string","id":"parentProcessInstanceId","description":"父流程实例ID"},"processInstanceId":{"type":"string","id":"processInstanceId","required":true,"description":"流程实例Id"},"status":{"type":"string","id":"status","required":true,"description":"流程实例状态[(01,新建未提交),(10,暂存为草稿),(21,流程出错),(30,流程结束),(40,挂起状态),(20,激活状态),(00,废弃状态)]"},"templateCode":{"type":"string","id":"templateCode","required":true,"description":"流程模板code"},"templateId":{"type":"string","id":"templateId","required":true,"description":"流程模板id"},"templateName":{"type":"string","id":"templateName","required":true,"description":"流程模板名称"},"timeoutTime":{"type":"integer","id":"timeoutTime","description":"流程超时时间,毫秒时间戳"}}}
*/
MKXFORM.callLbpm({
  functionCode: "process",
  param: ""
}, function(error, res){
  console.log(res)
})
```

### 查看审批意见记录

- API/name: `promise_查看审批意见记录`
- Purpose: 通过 MKXFORM.callLbpm 调用流程平台能力：查看审批意见记录，用于迁移依赖流程上下文、节点、任务、处理人或模板信息的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用流程平台接口，接口名称：查看审批意见记录
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"allowUploadAttachments":{"type":"boolean","id":"allowUploadAttachments","description":"是否允许上传附件"},"attachmentParameter":{"type":"array","id":"attachmentParameter","description":"附件参数","items":{"type":"object","properties":{"ext":{"type":"string","id":"ext","description":"扩展字段"},"fileId":{"type":"string","id":"fileId","description":"附件ID"},"id":{"type":"string","id":"id"},"name":{"type":"string","id":"name","description":"附件名称"},"type":{"type":"string","id":"type","description":"附件类型"},"url":{"type":"string","id":"url","description":"附件地址"}}}},"canAddCommentPostscript":{"type":"boolean","id":"canAddCommentPostscript","description":"是否可以添加流程附言"},"canModifyComment":{"type":"boolean","id":"canModifyComment","description":"处理意见是否可修改"},"children":{"type":"array","id":"children","description":"子级审批意见","items":{"type":"object"}},"commentPointList":{"type":"array","id":"commentPointList","description":"审批要点参数","items":{"type":"object","properties":{"fdCommentId":{"type":"string","id":"fdCommentId","description":"审批意见Id"},"fdId":{"type":"string","id":"fdId","description":"审批要点Id"},"fdIsCheck":{"type":"boolean","id":"fdIsCheck","description":"是否已核对"},"fdIsRequired":{"type":"boolean","id":"fdIsRequired","description":"是否必填"},"fdTitle":{"type":"string","id":"fdTitle","description":"标题"}}}},"dynamicProps":{"type":"object","id":"dynamicProps","description":"动态扩展属性"},"extProperty":{"type":"string","id":"extProperty","description":"业务扩展属性 {'preReviewType':'预审类型|Integer|0:秘书预审 1:高管见习'}"},"fdAction":{"type":"string","id":"fdAction","required":true,"description":"操作"},"fdActionCode":{"type":"string","id":"fdActionCode","required":true,"description":"操作编码"},"fdActionDesc":{"type":"string","id":"fdActionDesc","required":true,"description":"操作描述（系统操作）"},"fdActionName":{"type":"string","id":"fdActionName","description":"操作名称"},"fdActionTargets":{"type":"array","id":"fdActionTargets","description":"操作目标对象","items":{"type":"object","properties":{"fdKey":{"type":"string","id":"fdKey","description":"操作目标的业务标识，用于区分不同业务含义的操作对象"},"fdType":{"type":"string","id":"fdType","required":true,"description":"操作目标的类型，org(组织架构)/node(流程节点)"},"fdValue":{"type":"any","id":"fdValue","description":"操作目标的具体内容，具体的目标组织架构信息或具体的目标流程节点信息"}}}},"fdAgentType":{"type":"string","id":"fdAgentType","description":"代理类型"},"fdAgentUserId":{"type":"string","id":"fdAgentUserId","description":"被代理人"},"fdAgentUserOrgInfo":{"type":"object","id":"fdAgentUserOrgInfo","description":"被代理人组织架构信息","properties":{"dynamicProps":{"type":"object","id":"dynamicProps","description":"多语言"},"fdIsAvailable":{"type":"boolean","id":"fdIsAvailable","description":"是否有效"},"id":{"type":"string","id":"id","description":"组织架构id"},"loginName":{"type":"string","id":"loginName","description":"用户名称,只在类型为人员或身份时存在"},"name":{"type":"string","id":"name","description":"组织架构名称"},"number":{"type":"string","id":"number","description":"编号"},"orgType":{"type":"integer","id":"orgType","description":"组织架构类型,与生态组织一致  1:机构 2:部门 4:岗位 8:人员 16:群组 128:公共岗位 256:身份"},"parent":{"type":"object","id":"parent","description":"上级","properties":{"id":{"type":"string","id":"id","description":"组织架构id"},"name":{"type":"string","id":"name","description":"组织架构名称"}}},"post":{"type":"object","id":"post","description":"岗位","properties":{"id":{"type":"string","id":"id","description":"组织架构id"},"name":{"type":"string","id":"name","description":"组织架构名称"}}}}},"fdCooperateType":{"type":"integer","id":"fdCooperateType","description":"多人处理，流转方式"},"fdCreateTime":{"type":"integer","id":"fdCreateTime","required":true,"description":"创建时间"},"fdDefinitionNodeId":{"type":"string","id":"fdDefinitionNodeId","description":"节点定义Id"},"fdHandler":{"type":"string","id":"fdHandler","description":"处理人"},"fdHandlerDeptId":{"type":"string","id":"fdHandlerDeptId","description":"处理人部门ID"},"fdHandlerDeptName":{"type":"string","id":"fdHandlerDeptName","description":"处理人部门名称"},"fdHandlerId":{"type":"string","id":"fdHandlerId","required":true,"description":"处理人ID"},"fdHandlerIdentityId":{"type":"string","id":"fdHandlerIdentityId","description":"处理人身份id"},"fdHandlerIdentityName":{"type":"string","id":"fdHandlerIdentityName","description":"处理人身份名称"},"fdHandlerIdentityType":{"type":"integer","id":"fdHandlerIdentityType","description":"处理人身份类型"},"fdHandlerInfo":{"type":"string","id":"fdHandlerInfo","description":"处理人信息"},"fdHandlerName":{"type":"string","id":"fdHandlerName","description":"处理人名称"},"fdHandlerOrgInfo":{"type":"object","id":"fdHandlerOrgInfo","description":"处理人组织信息","properties":{"dynamicProps":{"type":"object","id":"dynamicProps","description":"多语言"},"fdIsAvailable":{"type":"boolean","id":"fdIsAvailable","description":"是否有效"},"id":{"type":"string","id":"id","description":"组织架构id"},"loginName":{"type":"string","id":"loginName","description":"用户名称,只在类型为人员或身份时存在"},"name":{"type":"string","id":"name","description":"组织架构名称"},"number":{"type":"string","id":"number","description":"编号"},"orgType":{"type":"integer","id":"orgType","description":"组织架构类型,与生态组织一致  1:机构 2:部门 4:岗位 8:人员 16:群组 128:公共岗位 256:身份"},"parent":{"type":"object","id":"parent","description":"上级","properties":{"id":{"type":"string","id":"id","description":"组织架构id"},"name":{"type":"string","id":"name","description":"组织架构名称"}}},"post":{"type":"object","id":"post","description":"岗位","properties":{"id":{"type":"string","id":"id","description":"组织架构id"},"name":{"type":"string","id":"name","description":"组织架构名称"}}}}},"fdId":{"type":"string","id":"fdId","required":true,"description":"记录主键"},"fdImg":{"type":"string","id":"fdImg","description":"头像地址"},"fdIsAvailable":{"type":"boolean","id":"fdIsAvailable","description":"是否有效"},"fdIsExistRecord":{"type":"boolean","id":"fdIsExistRecord","description":"处理意见是否存在修改记录"},"fdMessage":{"type":"string","id":"fdMessage","description":"处理意见"},"fdNodeId":{"type":"string","id":"fdNodeId","required":true,"description":"节点id"},"fdNodeInstanceId":{"type":"string","id":"fdNodeInstanceId","description":"节点任务id"},"fdNodeLanguage":{"type":"string","id":"fdNodeLanguage","description":"节点多语言"},"fdNodeName":{"type":"string","id":"fdNodeName","required":true,"description":"节点名称"},"fdNodeNumber":{"type":"string","id":"fdNodeNumber","description":"节点编号"},"fdNodeType":{"type":"string","id":"fdNodeType","required":true,"description":"节点类型"},"fdParentProcessInstanceId":{"type":"string","id":"fdParentProcessInstanceId","description":"父流程实例id"},"fdPrivateMessage":{"type":"boolean","id":"fdPrivateMessage","description":"是否是隐藏的处理意见(对于当前处理人而言)"},"fdProcessInstanceId":{"type":"string","id":"fdProcessInstanceId","required":true,"description":"流程实例id"},"fdRawMessage":{"type":"string","id":"fdRawMessage","description":"处理意见(富文本)"},"fdSubProcessStatus":{"type":"string","id":"fdSubProcessStatus","description":"节点状态，主要用于展示子流程的状态"},"fdTerminal":{"type":"string","id":"fdTerminal","description":"终端来源 0:pc端,1:企业微信,2:钉钉,3:飞书,4:KK,5:邮件审批"},"fdTotalCost":{"type":"string","id":"fdTotalCost","description":"总耗时"},"fdWorkCost":{"type":"string","id":"fdWorkCost","description":"工作日耗时"},"hide":{"type":"boolean","id":"hide","description":"是否隐藏"},"isLook":{"type":"boolean","id":"isLook","description":"是否已阅读"},"lbpmCommentPostscriptVOS":{"type":"array","id":"lbpmCommentPostscriptVOS","description":"流程附言","items":{"type":"object","properties":{"attachments":{"type":"array","id":"attachments","description":"流程附言附件","items":{"type":"object","properties":{"ext":{"type":"string","id":"ext","description":"扩展字段"},"fileId":{"type":"string","id":"fileId","description":"附件ID"},"id":{"type":"string","id":"id"},"name":{"type":"string","id":"name","description":"附件名称"},"type":{"type":"string","id":"type","description":"附件类型"},"url":{"type":"string","id":"url","description":"附件地址"}}}},"commentId":{"type":"string","id":"commentId","required":true,"description":"审批意见主键"},"content":{"type":"string","id":"content","required":true,"description":"附言内容"},"createTime":{"type":"integer","id":"createTime","description":"创建时间"},"dynamicProps":{"type":"object","id":"dynamicProps","description":"动态扩展属性"},"fdId":{"type":"string","id":"fdId","description":"记录主键"},"id":{"type":"string","id":"id","required":true,"description":"记录主键"},"mechanisms":{"type":"object","id":"mechanisms"},"needNotify":{"type":"boolean","id":"needNotify"},"notifyTarget":{"type":"string","id":"notifyTarget","enum":["notifyDraft","notifyCurHandlers","notifyHistoryHandlers"]},"notifyTypes":{"type":"array","id":"notifyTypes","items":{"type":"string"}},"nullValueProps":{"type":"array","id":"nullValueProps","description":"置空属性","items":{"type":"string"}},"processInstanceId":{"type":"string","id":"processInstanceId","required":true,"description":"流程实例Id"},"updateTime":{"type":"integer","id":"updateTime","description":"更新时间"},"userId":{"type":"string","id":"userId","required":true,"description":"评论人Id"},"userOrgInfo":{"type":"object","id":"userOrgInfo","description":"处理人信息","properties":{"dynamicProps":{"type":"object","id":"dynamicProps","description":"动态扩展属性"},"fdCategoryId":{"type":"string","id":"fdCategoryId"},"fdEmail":{"type":"string","id":"fdEmail","description":"邮箱"},"fdHierarchyId":{"type":"string","id":"fdHierarchyId","description":"层级ID"},"fdId":{"type":"string","id":"fdId","description":"记录主键"},"fdIsAvailable":{"type":"boolean","id":"fdIsAvailable","description":"是否有效"},"fdIsBusiness":{"type":"boolean","id":"fdIsBusiness","description":"是否业务相关"},"fdKeyword":{"type":"string","id":"fdKeyword","description":"关键字"},"fdLastModifiedTime":{"type":"integer","id":"fdLastModifiedTime","description":"摘要表最后修改时间","format":"utc-millisec"},"fdLoginName":{"type":"string","id":"fdLoginName","description":"登录名"},"fdMobileNo":{"type":"string","id":"fdMobileNo","description":"手机号"},"fdName":{"type":"string","id":"fdName","description":"组织名称"},"fdNo":{"type":"string","id":"fdNo","description":"编号"},"fdOrgType":{"type":"integer","id":"fdOrgType","description":"组织类型"},"fdOriId":{"type":"string","id":"fdOriId","description":"原始ID"},"fdParent":{"type":"object","id":"fdParent","description":"上级","properties":{"fdId":{"type":"string","id":"fdId","description":"对象主键"},"fdName":{"type":"string","id":"fdName","description":"对象显示名"}}},"fdParentOrg":{"type":"object","id":"fdParentOrg","description":"上级机构","properties":{"fdId":{"type":"string","id":"fdId","description":"对象主键"},"fdName":{"type":"string","id":"fdName","description":"对象显示名"}}},"fdRelPerson":{"type":"object","id":"fdRelPerson","description":"256身份关联的用户","properties":{"fdId":{"type":"string","id":"fdId","description":"对象主键"},"fdName":{"type":"string","id":"fdName","description":"对象显示名"}}},"fdTenantId":{"type":"integer","id":"fdTenantId","description":"租户ID"},"fdTreeLevel":{"type":"integer","id":"fdTreeLevel","description":"树层级"},"mechanisms":{"type":"object","id":"mechanisms","description":"机制数据"},"nullValueProps":{"type":"array","id":"nullValueProps","description":"置空属性","items":{"type":"string"}}}}}}},"mechanisms":{"type":"object","id":"mechanisms","description":"机制数据"},"nullValueProps":{"type":"array","id":"nullValueProps","description":"置空属性","items":{"type":"string"}},"srcCommentId":{"type":"string","id":"srcCommentId","description":"来源操作日志Id"},"taskAcceptTime":{"type":"integer","id":"taskAcceptTime","description":"任务接收时间"}}}}
*/
MKXFORM.callLbpm({
  functionCode: "listNote",
  param: {"nodeNumber":"","processInstanceId":""}
}, function(error, res){
  console.log(res)
})
```

### 获取节点历史处理人

- API/name: `promise_获取节点历史处理人`
- Purpose: 通过 MKXFORM.callLbpm 调用流程平台能力：获取节点历史处理人，用于迁移依赖流程上下文、节点、任务、处理人或模板信息的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用流程平台接口，接口名称：获取节点历史处理人
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"dynamicProps":{"type":"object","id":"dynamicProps","description":"动态扩展属性"},"fdCategoryId":{"type":"string","id":"fdCategoryId"},"fdEmail":{"type":"string","id":"fdEmail","description":"邮箱"},"fdHierarchyId":{"type":"string","id":"fdHierarchyId","description":"层级ID"},"fdId":{"type":"string","id":"fdId","description":"记录主键"},"fdIsAvailable":{"type":"boolean","id":"fdIsAvailable","description":"是否有效"},"fdIsBusiness":{"type":"boolean","id":"fdIsBusiness","description":"是否业务相关"},"fdKeyword":{"type":"string","id":"fdKeyword","description":"关键字"},"fdLastModifiedTime":{"type":"integer","id":"fdLastModifiedTime","description":"摘要表最后修改时间","format":"utc-millisec"},"fdLoginName":{"type":"string","id":"fdLoginName","description":"登录名"},"fdMobileNo":{"type":"string","id":"fdMobileNo","description":"手机号"},"fdName":{"type":"string","id":"fdName","description":"组织名称"},"fdNo":{"type":"string","id":"fdNo","description":"编号"},"fdOrgType":{"type":"integer","id":"fdOrgType","description":"组织类型"},"fdOriId":{"type":"string","id":"fdOriId","description":"原始ID"},"fdParent":{"type":"object","id":"fdParent","description":"上级","properties":{"fdId":{"type":"string","id":"fdId","description":"对象主键"},"fdName":{"type":"string","id":"fdName","description":"对象显示名"}}},"fdParentOrg":{"type":"object","id":"fdParentOrg","description":"上级机构","properties":{"fdId":{"type":"string","id":"fdId","description":"对象主键"},"fdName":{"type":"string","id":"fdName","description":"对象显示名"}}},"fdRelPerson":{"type":"object","id":"fdRelPerson","description":"256身份关联的用户","properties":{"fdId":{"type":"string","id":"fdId","description":"对象主键"},"fdName":{"type":"string","id":"fdName","description":"对象显示名"}}},"fdTenantId":{"type":"integer","id":"fdTenantId","description":"租户ID"},"fdTreeLevel":{"type":"integer","id":"fdTreeLevel","description":"树层级"},"mechanisms":{"type":"object","id":"mechanisms","description":"机制数据"},"nullValueProps":{"type":"array","id":"nullValueProps","description":"置空属性","items":{"type":"string"}}}}}
*/
MKXFORM.callLbpm({
  functionCode: "getNodeHistoryHandlers",
  param: {"containCommunicate":false,"nodeNumber":"","processInstanceId":"","returnIdentity":false}
}, function(error, res){
  console.log(res)
})
```

### 获取任务信息

- API/name: `promise_获取任务信息`
- Purpose: 通过 MKXFORM.callLbpm 调用流程平台能力：获取任务信息，用于迁移依赖流程上下文、节点、任务、处理人或模板信息的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用流程平台接口，接口名称：获取任务信息
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"object","properties":{"dynamicProps":{"type":"object","id":"dynamicProps","description":"动态参数,多语言信息在这里"},"handlerList":{"type":"array","id":"handlerList","description":"任务处理人列表","items":{"type":"object","properties":{"dynamicProps":{"type":"object","id":"dynamicProps","description":"多语言"},"fdIsAvailable":{"type":"boolean","id":"fdIsAvailable","description":"是否有效"},"id":{"type":"string","id":"id","description":"组织架构id"},"loginName":{"type":"string","id":"loginName","description":"用户名称,只在类型为人员或身份时存在"},"name":{"type":"string","id":"name","description":"组织架构名称"},"number":{"type":"string","id":"number","description":"编号"},"orgType":{"type":"integer","id":"orgType","description":"组织架构类型,与生态组织一致  1:机构 2:部门 4:岗位 8:人员 16:群组 128:公共岗位 256:身份"},"parent":{"type":"object","id":"parent","description":"上级","properties":{"id":{"type":"string","id":"id","description":"组织架构id"},"name":{"type":"string","id":"name","description":"组织架构名称"}}},"post":{"type":"object","id":"post","description":"岗位","properties":{"id":{"type":"string","id":"id","description":"组织架构id"},"name":{"type":"string","id":"name","description":"组织架构名称"}}}}}},"id":{"type":"string","id":"id","required":true,"description":"任务ID"},"name":{"type":"string","id":"name","required":true,"description":"任务所属节点名称"},"nodeNumber":{"type":"string","id":"nodeNumber","required":true,"description":"任务所属节点编号"},"receiveTime":{"type":"integer","id":"receiveTime","required":true,"description":"任务接收时间,毫秒时间戳"},"submitTime":{"type":"integer","id":"submitTime","description":"任务提交时间,毫秒时间戳"},"timeoutTime":{"type":"integer","id":"timeoutTime","description":"任务超时时间,毫秒时间戳"}}}
*/
MKXFORM.callLbpm({
  functionCode: "task",
  param: ""
}, function(error, res){
  console.log(res)
})
```

### 获取流程当前节点编号

- API/name: `promise_获取流程当前节点编号`
- Purpose: 通过 MKXFORM.callLbpm 调用流程平台能力：获取流程当前节点编号，用于迁移依赖流程上下文、节点、任务、处理人或模板信息的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用流程平台接口，接口名称：获取流程当前节点编号，返回以';'分隔的节点编号
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"string"}
*/
MKXFORM.callLbpm({
  functionCode: "getCurrentNodesNumber",
  param: {"formInstanceId":"","processInstanceId":""}
}, function(error, res){
  console.log(res)
})
```

### 获取节点名称

- API/name: `promise_获取节点名称`
- Purpose: 通过 MKXFORM.callLbpm 调用流程平台能力：获取节点名称，用于迁移依赖流程上下文、节点、任务、处理人或模板信息的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用流程平台接口，接口名称：在当前流程实例中根据节点ID获取节点名称
示例：#获取节点名称#("1ga8jfp9qw5dw2ckw15srfna20crns128pw0")
示例描述：在当前流程实例中根据节点ID:1ga8jfp9qw5dw2ckw15srfna20crns128pw0获取节点名称
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"string"}
*/
MKXFORM.callLbpm({
  functionCode: "getNodeFactName",
  param: {"nodeId":"","processInstanceId":""}
}, function(error, res){
  console.log(res)
})
```

### 获取流程当前处理人

- API/name: `promise_获取流程当前处理人`
- Purpose: 通过 MKXFORM.callLbpm 调用流程平台能力：获取流程当前处理人，用于迁移依赖流程上下文、节点、任务、处理人或模板信息的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用流程平台接口，接口名称：获取流程当前处理人
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"dynamicProps":{"type":"object","id":"dynamicProps","description":"动态扩展属性"},"fdCategoryId":{"type":"string","id":"fdCategoryId"},"fdEmail":{"type":"string","id":"fdEmail","description":"邮箱"},"fdHierarchyId":{"type":"string","id":"fdHierarchyId","description":"层级ID"},"fdId":{"type":"string","id":"fdId","description":"记录主键"},"fdIsAvailable":{"type":"boolean","id":"fdIsAvailable","description":"是否有效"},"fdIsBusiness":{"type":"boolean","id":"fdIsBusiness","description":"是否业务相关"},"fdKeyword":{"type":"string","id":"fdKeyword","description":"关键字"},"fdLastModifiedTime":{"type":"integer","id":"fdLastModifiedTime","description":"摘要表最后修改时间","format":"utc-millisec"},"fdLoginName":{"type":"string","id":"fdLoginName","description":"登录名"},"fdMobileNo":{"type":"string","id":"fdMobileNo","description":"手机号"},"fdName":{"type":"string","id":"fdName","description":"组织名称"},"fdNo":{"type":"string","id":"fdNo","description":"编号"},"fdOrgType":{"type":"integer","id":"fdOrgType","description":"组织类型"},"fdOriId":{"type":"string","id":"fdOriId","description":"原始ID"},"fdParent":{"type":"object","id":"fdParent","description":"上级","properties":{"fdId":{"type":"string","id":"fdId","description":"对象主键"},"fdName":{"type":"string","id":"fdName","description":"对象显示名"}}},"fdParentOrg":{"type":"object","id":"fdParentOrg","description":"上级机构","properties":{"fdId":{"type":"string","id":"fdId","description":"对象主键"},"fdName":{"type":"string","id":"fdName","description":"对象显示名"}}},"fdRelPerson":{"type":"object","id":"fdRelPerson","description":"256身份关联的用户","properties":{"fdId":{"type":"string","id":"fdId","description":"对象主键"},"fdName":{"type":"string","id":"fdName","description":"对象显示名"}}},"fdTenantId":{"type":"integer","id":"fdTenantId","description":"租户ID"},"fdTreeLevel":{"type":"integer","id":"fdTreeLevel","description":"树层级"},"mechanisms":{"type":"object","id":"mechanisms","description":"机制数据"},"nullValueProps":{"type":"array","id":"nullValueProps","description":"置空属性","items":{"type":"string"}}}}}
*/
MKXFORM.callLbpm({
  functionCode: "getCurrentHandlers",
  param: {"formInstanceId":"","processInstanceId":""}
}, function(error, res){
  console.log(res)
})
```

### 获取当前起草人身份

- API/name: `promise_获取当前起草人身份`
- Purpose: 通过 MKXFORM.callLbpm 调用流程平台能力：获取当前起草人身份，用于迁移依赖流程上下文、节点、任务、处理人或模板信息的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用流程平台接口，接口名称：获取当前起草人身份
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"object","properties":{"dynamicProps":{"type":"object","id":"dynamicProps","description":"动态扩展属性"},"fdCategoryId":{"type":"string","id":"fdCategoryId"},"fdEmail":{"type":"string","id":"fdEmail","description":"邮箱"},"fdHierarchyId":{"type":"string","id":"fdHierarchyId","description":"层级ID"},"fdId":{"type":"string","id":"fdId","description":"记录主键"},"fdIsAvailable":{"type":"boolean","id":"fdIsAvailable","description":"是否有效"},"fdIsBusiness":{"type":"boolean","id":"fdIsBusiness","description":"是否业务相关"},"fdKeyword":{"type":"string","id":"fdKeyword","description":"关键字"},"fdLastModifiedTime":{"type":"integer","id":"fdLastModifiedTime","description":"摘要表最后修改时间","format":"utc-millisec"},"fdLoginName":{"type":"string","id":"fdLoginName","description":"登录名"},"fdMobileNo":{"type":"string","id":"fdMobileNo","description":"手机号"},"fdName":{"type":"string","id":"fdName","description":"组织名称"},"fdNo":{"type":"string","id":"fdNo","description":"编号"},"fdOrgType":{"type":"integer","id":"fdOrgType","description":"组织类型"},"fdOriId":{"type":"string","id":"fdOriId","description":"原始ID"},"fdParent":{"type":"object","id":"fdParent","description":"上级","properties":{"fdId":{"type":"string","id":"fdId","description":"对象主键"},"fdName":{"type":"string","id":"fdName","description":"对象显示名"}}},"fdParentOrg":{"type":"object","id":"fdParentOrg","description":"上级机构","properties":{"fdId":{"type":"string","id":"fdId","description":"对象主键"},"fdName":{"type":"string","id":"fdName","description":"对象显示名"}}},"fdRelPerson":{"type":"object","id":"fdRelPerson","description":"256身份关联的用户","properties":{"fdId":{"type":"string","id":"fdId","description":"对象主键"},"fdName":{"type":"string","id":"fdName","description":"对象显示名"}}},"fdTenantId":{"type":"integer","id":"fdTenantId","description":"租户ID"},"fdTreeLevel":{"type":"integer","id":"fdTreeLevel","description":"树层级"},"mechanisms":{"type":"object","id":"mechanisms","description":"机制数据"},"nullValueProps":{"type":"array","id":"nullValueProps","description":"置空属性","items":{"type":"string"}}}}
*/
MKXFORM.callLbpm({
  functionCode: "getDrafIdentity",
  param: ""
}, function(error, res){
  console.log(res)
})
```

### 获取前一人工节点信息

- API/name: `promise_获取前一人工节点信息`
- Purpose: 通过 MKXFORM.callLbpm 调用流程平台能力：获取前一人工节点信息，用于迁移依赖流程上下文、节点、任务、处理人或模板信息的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用流程平台接口，接口名称：获取前一人工节点信息
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"dynamicProps":{"type":"object","id":"dynamicProps","description":"动态参数,多语言信息在这里"},"handlerList":{"type":"array","id":"handlerList","description":"节点处理人列表","items":{"type":"object","properties":{"dynamicProps":{"type":"object","id":"dynamicProps","description":"多语言"},"fdIsAvailable":{"type":"boolean","id":"fdIsAvailable","description":"是否有效"},"id":{"type":"string","id":"id","description":"组织架构id"},"loginName":{"type":"string","id":"loginName","description":"用户名称,只在类型为人员或身份时存在"},"name":{"type":"string","id":"name","description":"组织架构名称"},"number":{"type":"string","id":"number","description":"编号"},"orgType":{"type":"integer","id":"orgType","description":"组织架构类型,与生态组织一致  1:机构 2:部门 4:岗位 8:人员 16:群组 128:公共岗位 256:身份"},"parent":{"type":"object","id":"parent","description":"上级","properties":{"id":{"type":"string","id":"id","description":"组织架构id"},"name":{"type":"string","id":"name","description":"组织架构名称"}}},"post":{"type":"object","id":"post","description":"岗位","properties":{"id":{"type":"string","id":"id","description":"组织架构id"},"name":{"type":"string","id":"name","description":"组织架构名称"}}}}}},"name":{"type":"string","id":"name","required":true,"description":"节点名称"},"nodeId":{"type":"string","id":"nodeId","required":true,"description":"节点Id"},"nodeNumber":{"type":"string","id":"nodeNumber","required":true,"description":"节点编号"},"nodeType":{"type":"string","id":"nodeType","required":true,"description":"节点类型"}}}}
*/
MKXFORM.callLbpm({
  functionCode: "preManualNode",
  param: {"nodeId":"","nodeNumber":"","processInstanceId":"","taskId":""}
}, function(error, res){
  console.log(res)
})
```

### 获取前一人工任务Id

- API/name: `promise_获取前一人工任务Id`
- Purpose: 通过 MKXFORM.callLbpm 调用流程平台能力：获取前一人工任务Id，用于迁移依赖流程上下文、节点、任务、处理人或模板信息的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用流程平台接口，接口名称：获取前一人工任务Id
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"string"}
*/
MKXFORM.callLbpm({
  functionCode: "preManualTaskId",
  param: ""
}, function(error, res){
  console.log(res)
})
```

### 获取模板信息

- API/name: `promise_获取模板信息`
- Purpose: 通过 MKXFORM.callLbpm 调用流程平台能力：获取模板信息，用于迁移依赖流程上下文、节点、任务、处理人或模板信息的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用流程平台接口，接口名称：获取模板信息
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"object","properties":{"dynamicProps":{"type":"object","id":"dynamicProps","description":"动态参数,多语言信息在这里"},"fdCurrentVersionCode":{"type":"string","id":"fdCurrentVersionCode","description":"当前版本编号,没有发布版本时没有"},"fdId":{"type":"string","id":"fdId","required":true,"description":"模板ID"},"fdName":{"type":"string","id":"fdName","required":true,"description":"模板名称"},"fdTemplateCode":{"type":"string","id":"fdTemplateCode","required":true,"description":"模板编码"}}}
*/
MKXFORM.callLbpm({
  functionCode: "getTemplateInfo",
  param: {"templateCode":"","templateId":""}
}, function(error, res){
  console.log(res)
})
```

## 组织架构函数

Runtime group: `org_promise`. Count: 45.

### 查找人员和岗位

- API/name: `org_{sys-org:sysorg.getElementDatas.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找人员和岗位，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getElementDatas.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getElementDatas",
  param: {"address":[{"fdId":"15f8165c9524792842872204d97a2a18w0"}]}
}, function(error, res){
  console.log(res)
})
```

### 根据登录名查找人员

- API/name: `org_{sys-org:sysorg.getPersonByLoginName.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：根据登录名查找人员，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getPersonByLoginName.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdIsAvailable":{"description":"{sys-org:sysorg.fdIsAvailable}","id":"fdIsAvailable","type":"boolean"},"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getPersonByLoginName",
  param: {"loginName":"zhangsan"}
}, function(error, res){
  console.log(res)
})
```

### 根据用户ID查找人员

- API/name: `org_{sys-org:sysorg.getPersonByPersonId.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：根据用户ID查找人员，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getPersonByPersonId.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdLoginName":{"description":"{sys-org:sysorg.loginName}","id":"fdLoginName","type":"string"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getPersonByPersonId",
  param: {"fdPersonId":"1fjnd3td6w2bwacuw1tembm4367hujn3qmw0"}
}, function(error, res){
  console.log(res)
})
```

### 根据人员数组对象查找人员

- API/name: `org_{sys-org:sysorg.getPersonByPersons.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：根据人员数组对象查找人员，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getPersonByPersons.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdLoginName":{"description":"{sys-org:sysorg.loginName}","id":"fdLoginName","type":"string"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getPersonByPersons",
  param: {"address":[{"fdId":"1fjnd3td6w2bwacuw1tembm4367hujn3qmw0"},{"fdId":"1fjnd8cdew2bwbaiw2vb0jdr1bg3aj32v6w0"}]}
}, function(error, res){
  console.log(res)
})
```

### 查找岗位用户

- API/name: `org_{sys-org:sysorg.getPostPersons.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找岗位用户，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getPostPersons.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getPostPersons",
  param: {"postNameObj":"秘书","addressObject":{"fdId":"1fjnd8cdew2bwbaiw2vb0jdr1bg3aj32v6w0"}}
}, function(error, res){
  console.log(res)
})
```

### 查找公共岗位用户

- API/name: `org_{sys-org:sysorg.getOrgCommPostPersons.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找公共岗位用户，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getOrgCommPostPersons.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getOrgCommPostPersons",
  param: {"postNameObj":"15f8165c9524792842872204d97a2a18w0","addressObject":{"fdId":"1fjnd8cdew2bwbaiw2vb0jdr1bg3aj32v6w0"}}
}, function(error, res){
  console.log(res)
})
```

### 查找用户的所有岗位

- API/name: `org_{sys-org:sysorg.getAllPostByPersons.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找用户的所有岗位，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getAllPostByPersons.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.post.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.post.fdId}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getAllPostByPersons",
  param: {"address":[{"fdId":"1fjnd8cdew2bwbaiw2vb0jdr1bg3aj32v6w0"}]}
}, function(error, res){
  console.log(res)
})
```

### 查找所属部门

- API/name: `org_{sys-org:sysorg.getThisDepartment.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找所属部门，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getThisDepartment.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.dept.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.dept.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getThisDepartment",
  param: {"address":[{"fdId":"1fjnd3td6w2bwacuw1tembm4367hujn3qmw0"},{"fdId":"15f8165c9524792842872204d97a2a18w0"}]}
}, function(error, res){
  console.log(res)
})
```

### 获取部门全路径

- API/name: `org_{sys-org:sysorg.getDepartmentAllPath.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：获取部门全路径，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getDepartmentAllPath.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"string"}
*/
MKXFORM.callOrg({
  id: "sysorg.getDepartmentAllPath",
  param: {"addressObject":{"fdId":"1fjnd8cdew2bwbaiw2vb0jdr1bg3aj32v6w0"}}
}, function(error, res){
  console.log(res)
})
```

### 查找第X级部门

- API/name: `org_{sys-org:sysorg.getDepartmentByLevel.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找第X级部门，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getDepartmentByLevel.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.element.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.element.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getDepartmentByLevel",
  param: {"level":2,"addressObject":{"fdId":"1fjnd3td6w2bwacuw1tembm4367hujn3qmw0"}}
}, function(error, res){
  console.log(res)
})
```

### 查找所属机构

- API/name: `org_{sys-org:sysorg.getOrganization.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找所属机构，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getOrganization.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.org.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.org.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getOrganization",
  param: {"address":[{"fdId":"1gad1dndgw7nw1qnwl0vtmlmms14937iu8w0"},{"fdId":"1gakmvmgpw17wonw1g1n0ov22vd7lt3jj6w0"}]}
}, function(error, res){
  console.log(res)
})
```

### 查找部门领导

- API/name: `org_{sys-org:sysorg.getDepartmentHead.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找部门领导，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getDepartmentHead.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getDepartmentHead",
  param: {"address":[{"fdId":"1199w0"},{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}]}
}, function(error, res){
  console.log(res)
})
```

### 查找上级部门领导

- API/name: `org_{sys-org:sysorg.getSuperiorDepartmenthead.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找上级部门领导，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getSuperiorDepartmenthead.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getSuperiorDepartmenthead",
  param: {"condition":true,"address":[{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}]}
}, function(error, res){
  console.log(res)
})
```

### 获取第X级部门领导

- API/name: `org_{sys-org:sysorg.getDepartmentLeaderByLevel.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：获取第X级部门领导，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getDepartmentLeaderByLevel.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"string"}
*/
MKXFORM.callOrg({
  id: "sysorg.getDepartmentLeaderByLevel",
  param: {"level":3,"addressObject":{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}}
}, function(error, res){
  console.log(res)
})
```

### 递归查找多级部门领导

- API/name: `org_{sys-org:sysorg.getDepartmentLeadersByLevel.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：递归查找多级部门领导，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getDepartmentLeadersByLevel.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getDepartmentLeadersByLevel",
  param: {"level":3,"addressObject":{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}}
}, function(error, res){
  console.log(res)
})
```

### 查找部门领导(高级)函数

- API/name: `org_{sys-org:sysorg.getOneDepartmentLeadersByLevel.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找部门领导(高级)函数，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getOneDepartmentLeadersByLevel.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.personOrPost.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.personOrPost.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getOneDepartmentLeadersByLevel",
  param: {"address":[{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}],"level":0}
}, function(error, res){
  console.log(res)
})
```

### 是否本部门领导

- API/name: `org_{sys-org:sysorg.isDepartmentLeaderMyself.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：是否本部门领导，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.isDepartmentLeaderMyself.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"boolean"}
*/
MKXFORM.callOrg({
  id: "sysorg.isDepartmentLeaderMyself",
  param: {"address":[{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}]}
}, function(error, res){
  console.log(res)
})
```

### 是否部门领导

- API/name: `org_{sys-org:sysorg.isDepartmentLeaderForPerson.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：是否部门领导，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.isDepartmentLeaderForPerson.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"boolean"}
*/
MKXFORM.callOrg({
  id: "sysorg.isDepartmentLeaderForPerson",
  param: {"address":[{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}],"organizations":[{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}]}
}, function(error, res){
  console.log(res)
})
```

### 查找机构领导

- API/name: `org_{sys-org:sysorg.getOrgHead.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找机构领导，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getOrgHead.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getOrgHead",
  param: {"address":[{"fdId":"1fjnd3td6w2bwacuw1tembm4367hujn3qmw0"}]}
}, function(error, res){
  console.log(res)
})
```

### 岗位判断函数

- API/name: `org_{sys-org:sysorg.isRoleMember.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：岗位判断函数，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.isRoleMember.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"boolean"}
*/
MKXFORM.callOrg({
  id: "sysorg.isRoleMember",
  param: {"address":[{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}],"orgPost":{"fdId":"15f8165c9524792842872204d97a2a18w0"}}
}, function(error, res){
  console.log(res)
})
```

### 查找部门上级领导

- API/name: `org_{sys-org:sysorg.getDepartmentSuperLeaderByLevel.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找部门上级领导，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getDepartmentSuperLeaderByLevel.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getDepartmentSuperLeaderByLevel",
  param: {"level":1,"organizations":[{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}]}
}, function(error, res){
  console.log(res)
})
```

### 成员判定函数

- API/name: `org_{sys-org:sysorg.isMember.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：成员判定函数，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.isMember.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"boolean"}
*/
MKXFORM.callOrg({
  id: "sysorg.isMember",
  param: {"parent":{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"},"address":[{"fdId":"15f8165c9524792842872204d97a2a18w0"}]}
}, function(error, res){
  console.log(res)
})
```

### 组织包含标签函数

- API/name: `org_{sys-org:sysorg.isContainsLabel.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：组织包含标签函数，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.isContainsLabel.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"boolean"}
*/
MKXFORM.callOrg({
  id: "sysorg.isContainsLabel",
  param: {"org":{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"},"orgLabel":"label_1"}
}, function(error, res){
  console.log(res)
})
```

### 当前用户包含任一标签

- API/name: `org_{sys-org:sysorg.isUserContainsAnyLabel.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：当前用户包含任一标签，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.isUserContainsAnyLabel.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"boolean"}
*/
MKXFORM.callOrg({
  id: "sysorg.isUserContainsAnyLabel",
  param: {"orgLabels":["label_1","label_2"]}
}, function(error, res){
  console.log(res)
})
```

### 获取标签最近组织函数

- API/name: `org_{sys-org:sysorg.getParentOrgAboutLabel.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：获取标签最近组织函数，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getParentOrgAboutLabel.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getParentOrgAboutLabel",
  param: {"org":{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"},"orgLabel":"label_1"}
}, function(error, res){
  console.log(res)
})
```

### 获取组织标签名称

- API/name: `org_{sys-org:sysorg.getOrgLabelName.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：获取组织标签名称，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getOrgLabelName.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"string"}
*/
MKXFORM.callOrg({
  id: "sysorg.getOrgLabelName",
  param: {"org":{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}}
}, function(error, res){
  console.log(res)
})
```

### 获取组织标签

- API/name: `org_{sys-org:sysorg.getOrgLabel.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：获取组织标签，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getOrgLabel.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.label.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.label.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getOrgLabel",
  param: {"org":{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}}
}, function(error, res){
  console.log(res)
})
```

### 根据名称查找组织标签

- API/name: `org_{sys-org:sysorg.getOrgLabelByName.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：根据名称查找组织标签，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getOrgLabelByName.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.label.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.label.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getOrgLabelByName",
  param: {"orgLabelNameObj":"label_1;label_2"}
}, function(error, res){
  console.log(res)
})
```

### 查找组织属性

- API/name: `org_{sys-org:sysorg.getOrgAttributeVal.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找组织属性，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getOrgAttributeVal.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"string"}
*/
MKXFORM.callOrg({
  id: "sysorg.getOrgAttributeVal",
  param: {"orgType":8,"strOrgAttribute":"fdName","addressObject":{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}}
}, function(error, res){
  console.log(res)
})
```

### 查看人/岗位组织标签

- API/name: `org_{sys-org:sysorg.getPersonOrPostLable.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查看人/岗位组织标签，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getPersonOrPostLable.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.label.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.label.fdId}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getPersonOrPostLable",
  param: {"org":{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}}
}, function(error, res){
  console.log(res)
})
```

### 获取部门层级函数

- API/name: `org_{sys-org:sysorg.getEleHierarchyId.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：获取部门层级函数，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getEleHierarchyId.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdLoginName":{"description":"{sys-org:sysorg.loginName}","id":"fdLoginName","type":"string"},"fdOrgHierarchyId":{"description":"{sys-org:sysorg.fdOrgHierarchyId}","id":"fdOrgHierarchyId","type":"string"},"level":{"description":"{sys-org:sysorg.level}","id":"level","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdNoOrgHierarchyId":{"description":"{sys-org:sysorg.fdNoOrgHierarchyId}","id":"fdNoOrgHierarchyId","type":"string"},"fdHierarchyId":{"description":"{sys-org:sysorg.fdHierarchyId}","id":"fdHierarchyId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getEleHierarchyId",
  param: {"org":{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}}
}, function(error, res){
  console.log(res)
})
```

### 主部门判断函数

- API/name: `org_{sys-org:sysorg.checkDeptIsMain.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：主部门判断函数，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.checkDeptIsMain.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"integer"}
*/
MKXFORM.callOrg({
  id: "sysorg.checkDeptIsMain",
  param: {"person":{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"},"dept":{"fdId":"1fjnd0ph3w2bw9n2w1hqv8921b5dqeg3mow0"}}
}, function(error, res){
  console.log(res)
})
```

### 查找用户辅部门

- API/name: `org_{sys-org:sysorg.findUserAuxiliaryDept.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找用户辅部门，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.findUserAuxiliaryDept.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.dept.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.dept.fdName}","id":"fdName","type":"string"},"allDeptLevelName":{"description":"{sys-org:sysorg.allDeptLevelName}","id":"allDeptLevelName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.findUserAuxiliaryDept",
  param: {"addressObject":{"fdId":"1fjnd6jhdw2bwaslw24uhms93tdbv7v2i9w0"}}
}, function(error, res){
  console.log(res)
})
```

### 根据组织编码查找组织

- API/name: `org_{sys-org:sysorg.getElementByNo.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：根据组织编码查找组织，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getElementByNo.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdNo":{"description":"{sys-org:sysorg.element.fdNo}","id":"fdNo","type":"string"},"fdDeptNo":{"description":"{sys-org:sysorg.dept.fdNo}","id":"fdDeptNo","type":"string"},"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdDeptName":{"description":"{sys-org:sysorg.dept.fdName}","id":"fdDeptName","type":"string"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdDeptId":{"description":"{sys-org:sysorg.dept.fdId}","id":"fdDeptId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getElementByNo",
  param: {"fdNo":"10001","orgType":2}
}, function(error, res){
  console.log(res)
})
```

### 查找群组下的人员/岗位

- API/name: `org_{sys-org:sysorg.getPersonAndPostByGroup.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找群组下的人员/岗位，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getPersonAndPostByGroup.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.personOrPost.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.personOrPost.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getPersonAndPostByGroup",
  param: {"isCross":true,"group":{"fdId":"15f8165c9524792842872204d97a2a18w0"}}
}, function(error, res){
  console.log(res)
})
```

### 组织包含/属于函数

- API/name: `org_{sys-org:sysorg.isOrganizationBelongOrIncludeAnother.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：组织包含/属于函数，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.isOrganizationBelongOrIncludeAnother.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"boolean"}
*/
MKXFORM.callOrg({
  id: "sysorg.isOrganizationBelongOrIncludeAnother",
  param: {"relationType":2,"secondOrgs":[{"fdId":"1fjnd3td6w2bwacuw1tembm4367hujn3qmw0"}],"firstOrgs":[{"fdId":"15f8165c9524792842872204d97a2a18w0"}],"isCross":true}
}, function(error, res){
  console.log(res)
})
```

### 向上查找X级部门领导

- API/name: `org_{sys-org:sysorg.findUpXLevelLeader.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：向上查找X级部门领导，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.findUpXLevelLeader.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.leader.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.leader.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.findUpXLevelLeader",
  param: {"level":3,"isCross":true,"addressObject":{"fdId":"15f8165c9524792842872204d97a2a18w0"}}
}, function(error, res){
  console.log(res)
})
```

### 根据部门获取部门下人员列表

- API/name: `org_{sys-org:sysorg.queryDeptPersons.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：根据部门获取部门下人员列表，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.queryDeptPersons.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.loginName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.queryDeptPersons",
  param: {"isIncludeChild":true,"addressObject":{"fdId":"15f8165c9524792842872204d97a2a18w0"}}
}, function(error, res){
  console.log(res)
})
```

### 根据部门获取部门下人员身份列表

- API/name: `org_{sys-org:sysorg.queryDeptPersonsOrPersonIdentity.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：根据部门获取部门下人员身份列表，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.queryDeptPersonsOrPersonIdentity.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.loginName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.queryDeptPersonsOrPersonIdentity",
  param: {"isIncludeChild":true,"addressObject":{"fdId":"15f8165c9524792842872204d97a2a18w0"}}
}, function(error, res){
  console.log(res)
})
```

### 根据部门岗查找人员

- API/name: `org_{sys-org:sysorg.getPersonsByPost.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：根据部门岗查找人员，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getPersonsByPost.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdLoginName":{"description":"{sys-org:sysorg.loginName}","id":"fdLoginName","type":"string"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdId}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getPersonsByPost",
  param: {"address":[{"fdId":"1fjnd8cdew2bwbaiw2vb0jdr1bg3aj32v6w0"}]}
}, function(error, res){
  console.log(res)
})
```

### 根据部门岗位名称查找岗位或者岗位下的人员

- API/name: `org_{sys-org:sysorg.getPostOrPostPersonsByPostName.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：根据部门岗位名称查找岗位或者岗位下的人员，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getPostOrPostPersonsByPostName.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdId}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getPostOrPostPersonsByPostName",
  param: {"address":[{"orgType":4,"postNameObj":"财务人员"}]}
}, function(error, res){
  console.log(res)
})
```

### 获取当前身份

- API/name: `org_{sys-org:sysorg.getCurIdentityInfo.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：获取当前身份，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getCurIdentityInfo.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getCurIdentityInfo",
  param: undefined
}, function(error, res){
  console.log(res)
})
```

### 批量查找公共岗位用户

- API/name: `org_{sys-org:sysorg.getOrgCommPostPersonsMulti.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：批量查找公共岗位用户，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.getOrgCommPostPersonsMulti.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.person.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.person.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getOrgCommPostPersonsMulti",
  param: {"address":[{"fdId":"1fjnd8cdew2bwbaiw2vb0jdr1bg3aj32v6w0"},{"fdId":"1fjnd8cdew2bwbaiw2vb0jdr1bg3aj32v6w1"}],"postNameObj":"秘书"}
}, function(error, res){
  console.log(res)
})
```

### 查找群组下的直属成员

- API/name: `org_{sys-org:sysorg.expandByGroup.desc}`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：查找群组下的直属成员，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：{sys-org:sysorg.expandByGroup.desc}
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"array","items":{"type":"object","properties":{"fdOrgType":{"description":"{sys-org:sysorg.fdOrgType}","id":"fdOrgType","type":"integer"},"fdId":{"description":"{sys-org:sysorg.personOrPost.fdId}","id":"fdId","type":"string"},"fdName":{"description":"{sys-org:sysorg.personOrPost.fdName}","id":"fdName","type":"string"}}}}
*/
MKXFORM.callOrg({
  id: "sysorg.expandByGroup",
  param: {"group":{"fdId":"15f8165c9524792842872204d97a2a18w0"}}
}, function(error, res){
  console.log(res)
})
```

### 获取当前用户

- API/name: `org_#获取当前用户#，获取当前登录用户，返回用户对象`
- Purpose: 通过 MKXFORM.callOrg 调用组织架构能力：获取当前用户，用于迁移按人员、岗位、部门、机构、群组、身份等组织数据查询的旧脚本。
- Click verified: yes

Inserted code from right editor:

```javascript
/**
* 调用组织架构函数接口，接口名称：#获取当前用户#，获取当前登录用户，返回用户对象
* @param config 请求参数配置
* @param callback 回调函数
* 说明：
* 请求参数配置 config, functionCode 为函数的编码（即:函数标识
*
* 回调函数 callback
* 1. 参数error，当请求出错是会返回错误信息
* 2. 参数res，请求数据
* {"type":"object","properties":{"fdOrgType":{"description":"人员类型","id":"fdOrgType","type":"integer"},"fdLoginName":{"description":"人员登录名","id":"fdLoginName","type":"string"},"fdId":{"description":"人员id","id":"fdId","type":"string"},"fdName":{"description":"人员名称","id":"fdName","type":"string"}}}
*/
MKXFORM.callOrg({
  id: "sysorg.getCurUserInfo",
  param: undefined
}, function(error, res){
  console.log(res)
})
```
